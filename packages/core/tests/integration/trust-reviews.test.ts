import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import {
  RecordNotFoundError,
  REVIEWS_AUDIT,
  ReviewError,
  ReviewsRepository,
  type AuthContext,
} from "../../src/index";

/**
 * Verified-purchase reviews against a real Postgres (spec: "Trust — reviews"):
 * post-delivery eligibility, one review per order-line, moderation pipeline
 * PENDING → PUBLISHED/REJECTED with terminal protection, one supplier
 * response, org-level authorship in public reads, aggregates that count only
 * PUBLISHED reviews, and audit events on sensitive actions.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

let buyer!: { id: string; org: { id: string } };
let otherBuyer!: { id: string; org: { id: string } };
let supplier!: { id: string; org: { id: string } };
let staff!: { id: string; org: { id: string } };
let listingId!: string;

function authFor(person: { id: string; org: { id: string } }, role: AuthContext["role"]): AuthContext {
  return { userId: person.id, orgId: person.org.id, role };
}

const reviewsAs = (person: { id: string; org: { id: string } }, role: AuthContext["role"]) =>
  new ReviewsRepository(prisma, authFor(person, role));
const buyerReviews = () => reviewsAs(buyer, "BUYER");
const otherBuyerReviews = () => reviewsAs(otherBuyer, "BUYER");
const staffReviews = () => reviewsAs(staff, "AEKOVERA_STAFF");

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
          description: `Kraft mailer run ${emailTag}`,
          quantity: 1000,
          unitPriceCents: 42,
          totalCents: 42_000,
        },
      },
    },
    include: { orderLines: true },
  });
}

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
  const buyerUser = await prisma.user.create({ data: { email: "reviews-buyer@int.test" } });
  const buyerOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Reviews Buyer Co (integration)",
      slug: "reviews-buyer-int",
      members: { create: { userId: buyerUser.id, role: "BUYER" } },
    },
  });
  buyer = { id: buyerUser.id, org: { id: buyerOrg.id } };

  const otherUser = await prisma.user.create({ data: { email: "reviews-other@int.test" } });
  const otherOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Reviews Unrelated Co (integration)",
      slug: "reviews-unrelated-int",
      members: { create: { userId: otherUser.id, role: "BUYER" } },
    },
  });
  otherBuyer = { id: otherUser.id, org: { id: otherOrg.id } };

  const supplierUser = await prisma.user.create({ data: { email: "reviews-supplier@int.test" } });
  const supplierOrg = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Reviews Supplier Co (integration)",
      slug: "reviews-supplier-int",
      billingEmail: "front-desk@reviewssupplier.test",
      members: { create: { userId: supplierUser.id, role: "SUPPLIER_SALES" } },
      supplierProfile: { create: {} },
    },
  });
  supplier = { id: supplierUser.id, org: { id: supplierOrg.id } };

  const staffUser = await prisma.user.create({ data: { email: "reviews-staff@int.test" } });
  const platformOrg = await prisma.organization.create({
    data: {
      type: "PLATFORM",
      name: "Aekovera (reviews integration)",
      slug: "aekovera-reviews-int",
      members: { create: { userId: staffUser.id, role: "AEKOVERA_STAFF" } },
    },
  });
  staff = { id: staffUser.id, org: { id: platformOrg.id } };

  const category = await prisma.category.create({
    data: { name: "Reviews Flow Mailers", slug: "reviews-flow-mailers", attributeSet: {} },
  });
  const listing = await prisma.listing.create({
    data: {
      orgId: supplierOrg.id,
      categoryId: category.id,
      title: "Kraft Mailer (reviews flow)",
      slug: "reviews-flow-mailer",
      status: "LIVE",
      publishedAt: new Date(),
      attributes: {},
    },
  });
  listingId = listing.id;
});

describe("verified-purchase enforcement", () => {
  it("accepts a review from the buyer org on its own delivered order line", async () => {
    const order = await deliveredOrder("A");
    const review = await buyerReviews().createReview({
      orderId: order.id,
      orderLineId: order.orderLines[0]!.id,
      qualityRating: 5,
      communicationRating: 4,
      onTimeRating: 5,
      packagingAccuracyRating: 4,
      title: "Crisp print, on time",
      body: "Great run — questions to +1 555 010 1999 anytime.",
    });

    expect(review.moderationStatus).toBe("PENDING");
    expect(review.orderLineId).toBe(order.orderLines[0]!.id);
    expect(review.listingId).toBe(listingId); // derived from the ordered line
    expect(review.supplierOrgId).toBe(supplier.org.id);
    // Write-side contact hygiene: no phone number persists.
    expect(review.body).not.toContain("555 010 1999");

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: REVIEWS_AUDIT.create, entityId: review.id },
    });
    expect(audit.actorUserId).toBe(buyer.id);
  });

  it("denies a review on a non-delivered order", async () => {
    const order = await prisma.order.create({
      data: {
        orgId: buyer.org.id,
        buyerUserId: buyer.id,
        status: "DRAFT",
        paymentSchedule: "FULL_PREPAY",
        subOrders: { create: { orgId: supplier.org.id, status: "PENDING" } },
        orderLines: {
          create: {
            orgId: supplier.org.id,
            listingId,
            description: "Draft run",
            quantity: 10,
            unitPriceCents: 42,
            totalCents: 420,
          },
        },
      },
    });
    await expect(
      buyerReviews().createReview({
        orderId: order.id,
        qualityRating: 5,
        communicationRating: 5,
        onTimeRating: 5,
        packagingAccuracyRating: 5,
      }),
    ).rejects.toThrow(ReviewError);
  });

  it("denies a cross-org review as not-found so tenancy never leaks", async () => {
    const order = await deliveredOrder("B");
    await expect(
      otherBuyerReviews().createReview({
        orderId: order.id,
        qualityRating: 5,
        communicationRating: 5,
        onTimeRating: 5,
        packagingAccuracyRating: 5,
      }),
    ).rejects.toThrow(RecordNotFoundError);
  });

  it("denies a second review of the same order line", async () => {
    const order = await deliveredOrder("C");
    await buyerReviews().createReview({
      orderId: order.id,
      orderLineId: order.orderLines[0]!.id,
      qualityRating: 4,
      communicationRating: 4,
      onTimeRating: 4,
      packagingAccuracyRating: 4,
    });
    await expect(
      buyerReviews().createReview({
        orderId: order.id,
        orderLineId: order.orderLines[0]!.id,
        qualityRating: 5,
        communicationRating: 5,
        onTimeRating: 5,
        packagingAccuracyRating: 5,
      }),
    ).rejects.toThrow(ReviewError);
  });
});

describe("moderation pipeline and aggregates", () => {
  it("publishes pending reviews, counts only PUBLISHED in aggregates, and protects terminal states", async () => {
    const order = await deliveredOrder("D");
    const review = await buyerReviews().createReview({
      orderId: order.id,
      orderLineId: order.orderLines[0]!.id,
      qualityRating: 4,
      communicationRating: 3,
      onTimeRating: 5,
      packagingAccuracyRating: 5,
      title: "Solid run",
      body: "Registration was clean; dieline matched the spec.",
    });

    // A PENDING review is invisible publicly and to aggregates.
    expect((await buyerReviews().listingReviews(listingId)).map((r) => r.id)).not.toContain(review.id);
    expect((await buyerReviews().listingAggregate(listingId)).count).toBe(0);

    // Supplier responds; moderation publishes.
    const responded = await reviewsAs(supplier, "SUPPLIER_SALES").respondToReview(
      review.id,
      "Thanks — see you on the reorder.",
    );
    expect(responded.supplierResponse).toBe("Thanks — see you on the reorder.");
    await expect(
      reviewsAs(supplier, "SUPPLIER_SALES").respondToReview(review.id, "Second take"),
    ).rejects.toThrow(ReviewError); // one response per review

    const published = await staffReviews().moderate(review.id, "PUBLISH");
    expect(published.moderationStatus).toBe("PUBLISHED");
    expect(published.moderatedByUserId).toBe(staff.id);

    const publicReviews = await otherBuyerReviews().listingReviews(listingId);
    const visible = publicReviews.find((r) => r.id === review.id);
    expect(visible).toBeTruthy();
    expect(visible?.supplierResponse).toBe("Thanks — see you on the reorder.");
    // Org-level authorship only — no per-user identity leaks publicly.
    expect(visible?.reviewerOrgName).toBe("Reviews Buyer Co (integration)");
    expect(visible).not.toHaveProperty("authorUserId");

    const aggregate = await buyerReviews().listingAggregate(listingId);
    expect(aggregate.count).toBe(1);
    expect(aggregate.axes.qualityRating).toBe(4.0);

    // Terminal protection: a decided review cannot be re-decided.
    await expect(staffReviews().moderate(review.id, "REJECT", { reason: "second thoughts" })).rejects.toThrow(
      ReviewError,
    );
  });

  it("rejects with a reason that persists and keeps the review out of aggregates", async () => {
    const order = await deliveredOrder("E");
    const review = await buyerReviews().createReview({
      orderId: order.id,
      orderLineId: order.orderLines[0]!.id,
      qualityRating: 1,
      communicationRating: 1,
      onTimeRating: 1,
      packagingAccuracyRating: 1,
      body: "Visit our shop at http://spam.example for cheap deals",
    });

    const rejected = await staffReviews().moderate(review.id, "REJECT", { reason: "Contains promotional links" });
    expect(rejected.moderationStatus).toBe("REJECTED");
    expect(rejected.rejectionReason).toBe("Contains promotional links");

    // Aggregates keep counting the suite's earlier PUBLISHED review; the
    // rejected one joins neither the count nor the public read.
    const published = await buyerReviews().listingReviews(listingId);
    expect((await buyerReviews().listingAggregate(listingId)).count).toBe(1);
    expect(published.find((entry) => entry.id === review.id)).toBeUndefined();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: REVIEWS_AUDIT.moderate, entityId: review.id },
    });
    expect((audit.before as { moderationStatus: string }).moderationStatus).toBe("PENDING");
    expect((audit.after as { moderationStatus: string }).moderationStatus).toBe("REJECTED");
  });
});
