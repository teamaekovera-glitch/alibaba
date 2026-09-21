import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import { MockPaymentsAdapter, MockStorageAdapter, MockTrackingAdapter } from "@packsource/ai";
import {
  CartRepository,
  DisputeError,
  DisputesRepository,
  DISPUTES_AUDIT,
  OrderRepository,
  QuoteRepository,
  RfqRepository,
  type AuthContext,
} from "../../src/index";

/**
 * Dispute lifecycle against a real Postgres (spec: "Trust — disputes"):
 * participant-guarded discussion, evidence, staff pickup, withdrawal that
 * resumes the frozen order through the order machine, and the escrow-freeze
 * handoff — open dispute → escrow release frozen → withdraw → order resumes
 * to its pre-dispute status through the ACTUAL escrow contract.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const DAY = 24 * 60 * 60 * 1000;
const ports = {
  payments: new MockPaymentsAdapter(),
  tracking: new MockTrackingAdapter(),
  storage: new MockStorageAdapter(),
};

let buyer!: { id: string; org: { id: string } };
let otherBuyer!: { id: string; org: { id: string } };
let s1sales!: { id: string; org: { id: string } };
let staff!: { id: string; org: { id: string } };

function authFor(
  person: { id: string; org: { id: string } },
  role: AuthContext["role"],
): AuthContext {
  return { userId: person.id, orgId: person.org.id, role };
}

const ordersAs = (person: { id: string; org: { id: string } }, role: AuthContext["role"]) =>
  new OrderRepository(prisma, authFor(person, role), ports);
const buyerOrders = () => ordersAs(buyer, "BUYER");
const staffOrders = () => ordersAs(staff, "AEKOVERA_STAFF");
const buyerDisputes = () => new DisputesRepository(prisma, authFor(buyer, "BUYER"));
const supplierDisputes = () => new DisputesRepository(prisma, authFor(s1sales, "SUPPLIER_SALES"));
const otherBuyerDisputes = () => new DisputesRepository(prisma, authFor(otherBuyer, "BUYER"));
const staffDisputes = () => new DisputesRepository(prisma, authFor(staff, "AEKOVERA_STAFF"));

/** SINGLE-mode RFQ on the suite's listing, quoted and awarded to the buyer. */
async function awardOrder(title: string, emailTag: string) {
  const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "disputes-flow-mailer" } });
  const rfq = await new RfqRepository(prisma, authFor(buyer, "BUYER")).create({
    mode: "SINGLE",
    listingId: listing.id,
    categoryId: listing.categoryId,
    title,
    quantity: 1000,
    spec: { version: 1, destination: { city: "Portland", country: "US" }, needByDate: "2026-11-15" },
    lines: [{ description: "12x12x4 kraft corrugated mailer", quantity: 1000 }],
  });
  await new RfqRepository(prisma, authFor(buyer, "BUYER")).send(rfq.id);
  const quote = await new QuoteRepository(prisma, authFor(s1sales, "SUPPLIER_SALES")).submit({
    rfqId: rfq.id,
    leadTimeDays: 12,
    validUntil: new Date(Date.now() + 30 * DAY),
    dutyBps: 0,
    lines: [
      {
        description: "1,000 kraft mailers",
        quantity: 1000,
        unitPriceCents: 42,
        toolingCents: 15_000,
        plateChargesCents: 5_000,
        freightCents: 15_000,
      },
    ],
    message: `Quote ${emailTag} — dispute-flow run.`,
  });
  await new CartRepository(prisma, authFor(buyer, "BUYER")).addToCart(quote.id);
  const { order } = await new CartRepository(prisma, authFor(buyer, "BUYER")).acceptQuote(quote.id);
  return order;
}

/** Award → confirm (Net-30, staff approved) → production → shipment → SHIPPED. */
async function shippedOrder(title: string, emailTag: string) {
  const order = await awardOrder(title, emailTag);
  await buyerOrders().confirmOrder(order.id, { paymentSchedule: "NET_30", net30ApprovedAt: new Date() });
  await ordersAs(s1ops!, "SUPPLIER_OPS").completeProduction(order.id);
  const { shipment } = await ordersAs(s1ops!, "SUPPLIER_OPS").createShipment(order.id, {
    carrier: "FedEx",
  });
  await ordersAs(s1ops!, "SUPPLIER_OPS").markShipmentInTransit(shipment.id);
  return order;
}

let s1ops!: { id: string; org: { id: string } };

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
  const buyerUser = await prisma.user.create({ data: { email: "disputes-buyer@int.test" } });
  const buyerOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Disputes Buyer Co (integration)",
      slug: "disputes-buyer-int",
      members: { create: { userId: buyerUser.id, role: "BUYER" } },
    },
  });
  buyer = { id: buyerUser.id, org: { id: buyerOrg.id } };

  const otherUser = await prisma.user.create({ data: { email: "disputes-other@int.test" } });
  const otherOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Disputes Unrelated Co (integration)",
      slug: "disputes-unrelated-int",
      members: { create: { userId: otherUser.id, role: "BUYER" } },
    },
  });
  otherBuyer = { id: otherUser.id, org: { id: otherOrg.id } };

  const salesUser = await prisma.user.create({ data: { email: "disputes-s1-sales@int.test" } });
  const opsUser = await prisma.user.create({ data: { email: "disputes-s1-ops@int.test" } });
  const s1Org = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Disputes Supplier One (integration)",
      slug: "disputes-supplier-one-int",
      members: {
        create: [
          { userId: salesUser.id, role: "SUPPLIER_SALES" },
          { userId: opsUser.id, role: "SUPPLIER_OPS" },
        ],
      },
      supplierProfile: { create: {} },
    },
  });
  s1sales = { id: salesUser.id, org: { id: s1Org.id } };
  s1ops = { id: opsUser.id, org: { id: s1Org.id } };

  const staffUser = await prisma.user.create({ data: { email: "disputes-staff@int.test" } });
  const platformOrg = await prisma.organization.create({
    data: {
      type: "PLATFORM",
      name: "Aekovera (disputes integration)",
      slug: "aekovera-disputes-int",
      members: { create: { userId: staffUser.id, role: "AEKOVERA_STAFF" } },
    },
  });
  staff = { id: staffUser.id, org: { id: platformOrg.id } };

  const category = await prisma.category.create({
    data: { name: "Disputes Flow Mailers", slug: "disputes-flow-mailers", attributeSet: {} },
  });
  await prisma.listing.create({
    data: {
      orgId: s1Org.id,
      categoryId: category.id,
      title: "Kraft Mailer (disputes flow)",
      slug: "disputes-flow-mailer",
      status: "LIVE",
      publishedAt: new Date(),
      attributes: {},
    },
  });
});

describe("escrow-freeze handoff through the trust layer", () => {
  it("opens a dispute, freezes escrow, and withdrawal resumes the order to its pre-dispute status", async () => {
    const order = await shippedOrder("1,000 kraft mailers, withdraw run", "W");

    // Buyer opens the dispute → order freezes at DISPUTED.
    const dispute = await buyerOrders().openDispute(order.id, "Wrong print color on half the run");
    expect(dispute.status).toBe("OPEN");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DISPUTED");

    // The escrow contract freezes release while the dispute is open.
    const frozen = await ordersAs(s1ops, "SUPPLIER_OPS").releaseEscrow(order.id);
    expect(frozen).toEqual({ released: false, reason: "dispute-open" });
    expect(await prisma.payout.findMany({ where: { orderId: order.id } })).toHaveLength(0);

    // Trust-layer discussion while frozen: supplier responds, buyer attaches
    // evidence, staff picks the dispute up.
    const response = await supplierDisputes().respond(dispute.id, "Press check was signed off — send photos of the affected cartons.");
    expect(response.body).toBe("Press check was signed off — send photos of the affected cartons.");
    expect(response.orgId).toBe(s1sales.org.id);
    await buyerDisputes().attachEvidence(dispute.id, { fileId: "file_dispute_photo", note: "Half the run, wrong blue." });
    await staffDisputes().startReview(dispute.id);
    expect((await staffDisputes().disputeDetail(dispute.id)).dispute.status).toBe("UNDER_REVIEW");

    // Buyer withdraws → the order resumes to its pre-dispute status (SHIPPED)
    // through the order machine; escrow simply resumes the normal path.
    const withdrawn = await buyerDisputes().withdraw(dispute.id);
    expect(withdrawn.status).toBe("WITHDRAWN");
    const resumed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(resumed.status).toBe("SHIPPED");
    expect(resumed.status).not.toBe("DISPUTED");

    // A withdrawn dispute is terminal: no second withdrawal.
    await expect(buyerDisputes().withdraw(dispute.id)).rejects.toThrow(DisputeError);

    const buyerAudits = await prisma.auditLog.findMany({ where: { orgId: buyer.org.id } });
    expect(buyerAudits.map((a) => a.action)).toContain(DISPUTES_AUDIT.withdraw);
    const staffAudits = await prisma.auditLog.findMany({ where: { orgId: staff.org.id } });
    expect(staffAudits.map((a) => a.action)).toContain(DISPUTES_AUDIT.startReview);
  });
});

describe("participant guards and machine transitions", () => {
  it("hides disputes from non-participants and refuses their writes", async () => {
    const order = await shippedOrder("1,000 kraft mailers, guard run", "G");
    const dispute = await buyerOrders().openDispute(order.id, "Delivered late, trade show missed");

    await expect(otherBuyerDisputes().disputeDetail(dispute.id)).rejects.toThrow(); // not a participant
    await expect(
      otherBuyerDisputes().respond(dispute.id, "saw this order, just commenting"),
    ).rejects.toThrow(DisputeError);
    await expect(otherBuyerDisputes().startReview(dispute.id)).rejects.toThrow(); // staff-only

    // Participants see the redacted trail; staff sees everything.
    const detail = await buyerDisputes().disputeDetail(dispute.id);
    expect(detail.dispute.id).toBe(dispute.id);
    await staffDisputes().startReview(dispute.id);
    const staffDetail = await staffDisputes().disputeDetail(dispute.id);
    expect(staffDetail.dispute.status).toBe("UNDER_REVIEW");
  });

  it("resolves through the order contract and closes the discussion terminal", async () => {
    const order = await shippedOrder("1,000 kraft mailers, resolve run", "R");
    const dispute = await buyerOrders().openDispute(order.id, "Cartons crushed in transit");

    // Resolution stays in the order contract (PR #11): staff resolves with
    // release → escrow releases → payouts appear.
    await staffDisputes().startReview(dispute.id);
    await staffOrders().resolveDispute(order.id, dispute.id, { type: "RELEASE" });

    const resolvedDispute = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(resolvedDispute.status).toBe("RESOLVED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("ESCROW_RELEASED");
    expect(await prisma.payout.findMany({ where: { orderId: order.id } })).toHaveLength(1);

    // Terminal: no further discussion or withdrawal on a RESOLVED dispute.
    await expect(supplierDisputes().respond(dispute.id, "after the fact")).rejects.toThrow(DisputeError);
    await expect(buyerDisputes().withdraw(dispute.id)).rejects.toThrow(DisputeError);

    const staffAudits = await prisma.auditLog.findMany({ where: { orgId: staff.org.id } });
    expect(staffAudits.map((a) => a.action)).toContain("dispute.resolve");
  });
});
