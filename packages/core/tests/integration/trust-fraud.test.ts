import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import {
  FraudRateLimitError,
  MessagingRepository,
  ReviewError,
  ReviewsRepository,
  type AuthContext,
} from "../../src/index";

/**
 * Fraud controls against a real Postgres (spec: "Trust — fraud controls"):
 * sliding-window rate limits on review and message creation (boundary + window
 * expiry), duplicate-review fingerprinting that flags repeat-paste bodies,
 * and atomic counting (a rejected action leaves no orphan rows).
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

let buyer!: { id: string; org: { id: string } };
let supplier!: { id: string; org: { id: string } };
let staff!: { id: string; org: { id: string } };
let listingId!: string;

function authFor(person: { id: string; org: { id: string } }, role: AuthContext["role"]): AuthContext {
  return { userId: person.id, orgId: person.org.id, role };
}

const reviewsAs = (person: { id: string; org: { id: string } }, role: AuthContext["role"]) =>
  new ReviewsRepository(prisma, authFor(person, role));
const buyerReviews = () => reviewsAs(buyer, "BUYER");
const buyerMessaging = () => new MessagingRepository(prisma, authFor(buyer, "BUYER"));

/** Delivered order with one supplier leg anchored to the suite's listing. */
async function deliveredOrder(emailTag: string) {
  return prisma.order.create({
    data: {
      orgId: buyer.org.id,
      buyerUserId: buyer.id,
      status: "DELIVERED",
      paymentSchedule: "FULL_PREPAY",
      subOrders: { create: { orgId: supplier.org.id, status: "DELIVERED" } },
      orderLines: {
        create: {
          orgId: supplier.org.id,
          listingId,
          description: `Fraud-flow mailer run ${emailTag}`,
          quantity: 1000,
          unitPriceCents: 42,
          totalCents: 42_000,
        },
      },
    },
    include: { orderLines: true },
  });
}

const reviewFor = (order: Awaited<ReturnType<typeof deliveredOrder>>, body?: string) =>
  buyerReviews().createReview({
    orderId: order.id,
    orderLineId: order.orderLines[0]!.id,
    qualityRating: 4,
    communicationRating: 4,
    onTimeRating: 4,
    packagingAccuracyRating: 4,
    ...(body ? { body } : {}),
  });

beforeAll(() => {
  execSync("npx prisma migrate deploy", {
    cwd: dbPkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "AuditLog", "Category", "Listing", "Order" CASCADE`,
  );
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeAll(async () => {
  const buyerUser = await prisma.user.create({ data: { email: "fraud-buyer@int.test" } });
  const buyerOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Fraud Buyer Co (integration)",
      slug: "fraud-buyer-int",
      members: { create: { userId: buyerUser.id, role: "BUYER" } },
    },
  });
  buyer = { id: buyerUser.id, org: { id: buyerOrg.id } };

  const supplierUser = await prisma.user.create({ data: { email: "fraud-supplier@int.test" } });
  const supplierOrg = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Fraud Supplier Co (integration)",
      slug: "fraud-supplier-int",
      billingEmail: "front-desk@fraudsupplier.test",
      members: { create: { userId: supplierUser.id, role: "SUPPLIER_SALES" } },
      supplierProfile: { create: {} },
    },
  });
  supplier = { id: supplierUser.id, org: { id: supplierOrg.id } };

  const staffUser = await prisma.user.create({ data: { email: "fraud-staff@int.test" } });
  const platformOrg = await prisma.organization.create({
    data: {
      type: "PLATFORM",
      name: "Aekovera (fraud integration)",
      slug: "aekovera-fraud-int",
      members: { create: { userId: staffUser.id, role: "AEKOVERA_STAFF" } },
    },
  });
  staff = { id: staffUser.id, org: { id: platformOrg.id } };

  const category = await prisma.category.create({
    data: { name: "Fraud Flow Mailers", slug: "fraud-flow-mailers", attributeSet: {} },
  });
  const listing = await prisma.listing.create({
    data: {
      orgId: supplierOrg.id,
      categoryId: category.id,
      title: "Kraft Mailer (fraud flow)",
      slug: "fraud-flow-mailer",
      status: "LIVE",
      publishedAt: new Date(),
      attributes: {},
    },
  });
  listingId = listing.id;
});

describe("review rate limit", () => {
  it("caps reviews per org per day, expires the window, and counts atomically", async () => {
    // Boundary: five reviews land, the sixth is refused.
    const orders: Awaited<ReturnType<typeof deliveredOrder>>[] = [];
    for (let i = 0; i < 6; i += 1) {
      orders.push(await deliveredOrder(`R${i}`));
    }
    for (let i = 0; i < 5; i += 1) {
      await reviewFor(orders[i]!, `Review body number ${i} — solid run.`);
    }
    await expect(reviewFor(orders[5]!, "One too many today.")).rejects.toThrow(FraudRateLimitError);

    // Atomic counting: exactly five window events, and NO review row exists
    // for the refused sixth action.
    const events = await prisma.rateLimitEvent.findMany({
      where: { identifier: buyer.org.id, scope: "reviews" },
    });
    expect(events).toHaveLength(5);
    const sixth = await prisma.review.findFirst({
      where: { orderId: orders[5]!.id },
    });
    expect(sixth).toBeNull();

    // Window expiry: aging the events past 24h lets the next review through.
    await prisma.rateLimitEvent.updateMany({
      where: { identifier: buyer.org.id, scope: "reviews" },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const late = await reviewFor(orders[5]!, "The window rolled over.");
    expect(late.moderationStatus).toBe("PENDING");
  });
});

describe("duplicate-review detection", () => {
  it("flags and refuses a repeat-paste body from the same org within the lookback", async () => {
    const orderA = await deliveredOrder("D-A");
    const orderB = await deliveredOrder("D-B");
    await reviewFor(orderA, "Fantastic supplier, ask for Dana at dana@supplier.example");

    await expect(
      // Same text modulo case and whitespace — normalization collapses both,
      // so this is a repeat-paste even though the raw strings differ.
      reviewFor(orderB, "fantastic supplier,  ASK FOR DANA at dana@supplier.example"),
    ).rejects.toThrow(ReviewError);

    const flags = await prisma.fraudFlag.findMany({ where: { orgId: buyer.org.id } });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: "MEDIUM", subjectType: "listing" });
    expect(flags[0]?.reason).toContain("duplicate review body");

    // A materially different body on a fresh order passes the fingerprint.
    const orderC = await deliveredOrder("D-C");
    const distinct = await reviewFor(orderC, "Different words entirely — packaging held up in the rain.");
    expect(distinct.moderationStatus).toBe("PENDING");
  });
});

describe("message rate limit", () => {
  it("caps messages per org per hour and expires the window", async () => {
    const order = await deliveredOrder("M");
    const { thread } = await buyerMessaging().startThread({
      kind: "ORDER",
      orderId: order.id,
      body: "Kicking off the fraud-flow order thread.",
    });

    // Boundary: 60 messages land, the 61st is refused.
    for (let i = 0; i < 60; i += 1) {
      await buyerMessaging().postMessage(thread.id, { body: `Burst message ${i} — sequencing the print run.` });
    }
    await expect(
      buyerMessaging().postMessage(thread.id, { body: "One too many this hour." }),
    ).rejects.toThrow(FraudRateLimitError);
    const messageEvents = await prisma.rateLimitEvent.findMany({
      where: { identifier: buyer.org.id, scope: "messages" },
    });
    expect(messageEvents).toHaveLength(60);

    // Window expiry unblocks the conversation.
    await prisma.rateLimitEvent.updateMany({
      where: { identifier: buyer.org.id, scope: "messages" },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    const next = await buyerMessaging().postMessage(thread.id, { body: "Hour rolled over — back to the run." });
    expect(next.threadId).toBe(thread.id);
  });
});

describe("fraud-flag audit trail", () => {
  it("leaves an admin-visible record without cross-org leakage", async () => {
    // Flags are org-scoped: another org's review traffic creates no flags here.
    const otherFlags = await prisma.fraudFlag.findMany({ where: { orgId: staff.org.id } });
    expect(otherFlags).toHaveLength(0);
    const flags = await prisma.fraudFlag.findMany({ where: { orgId: buyer.org.id } });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.createdAt).toBeTruthy();
  });
});
