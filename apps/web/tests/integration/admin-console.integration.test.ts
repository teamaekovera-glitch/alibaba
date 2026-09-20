import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import {
  CartRepository,
  PermissionDeniedError,
  QuoteRepository,
  RfqRepository,
  type AuthContext,
} from "@packsource/core";
import { MockNotificationEmailAdapter, NotificationEngine } from "@packsource/notifications";

/**
 * Staff admin console + notification domain against a real pgvector Postgres:
 * permission denials on every admin surface, review moderation transitions
 * with audit + author notification, verification tier changes, dispute
 * resolution honoring PR #11's escrow freeze/resume contracts, membership
 * administration, and the filterable audit viewer.
 *
 * The admin lib functions take (db, auth, ...) explicitly — no session
 * mocking; AuthContexts are constructed directly.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://packsource:packsource@localhost:5432/packsource_test";

// Turbo's strict env mode strips undeclared vars, but the app's `@/lib/db`
// client guard requires DATABASE_URL at import time — pin it before any app
// module loads (same contract as the storefront suite).
process.env.DATABASE_URL ??= DATABASE_URL;

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../../packages/db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-05-10T09:00:00.000Z");

let staffUser!: { id: string; org: { id: string } };
let buyer!: { id: string; org: { id: string } };
let supplierOwner!: { id: string; org: { id: string } };
let supplierSales!: { id: string; org: { id: string } };

function authFor(person: { id: string; org: { id: string } }, role: AuthContext["role"]): AuthContext {
  return { userId: person.id, orgId: person.org.id, role };
}

const staffAuth = () => authFor(staffUser, "AEKOVERA_STAFF");
const buyerAuth = () => authFor(buyer, "BUYER");
const salesAuth = () => authFor(supplierSales, "SUPPLIER_SALES");

const email = new MockNotificationEmailAdapter();
const engineFor = (auth: AuthContext) =>
  new NotificationEngine(prisma, email, { actorType: "user", userId: auth.userId });

/** Single RFQ on the fixture listing, quoted and awarded -> DRAFT order. */
async function awardDraftOrder(title: string, emailTag: string) {
  const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "admin-console-mailer" } });
  const rfq = await new RfqRepository(prisma, buyerAuth()).create({
    mode: "SINGLE",
    listingId: listing.id,
    categoryId: listing.categoryId,
    title,
    quantity: 1000,
    spec: { version: 1, destination: { city: "Portland", country: "US" }, needByDate: "2026-11-15" },
    lines: [{ description: "12x12x4 kraft corrugated mailer", quantity: 1000 }],
  });
  await new RfqRepository(prisma, buyerAuth()).send(rfq.id);
  const quote = await new QuoteRepository(prisma, salesAuth()).submit({
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
    message: `Quote ${emailTag} for the admin console suite.`,
  });
  await new CartRepository(prisma, buyerAuth()).addToCart(quote.id);
  const { order } = await new CartRepository(prisma, buyerAuth()).acceptQuote(quote.id);
  return order;
}

const { moderateReview, ReviewModerationStateError } = await import("@/lib/admin/moderation");
const { setVerificationTier, VerificationStateError } = await import("@/lib/admin/verification");
const { resolveDisputeAsStaff } = await import("@/lib/admin/disputes");
const { setMemberRole, removeMember } = await import("@/lib/admin/directory");
const { auditLogPage } = await import("@/lib/admin/audit");
const { moderationQueue } = await import("@/lib/admin/moderation");
const { staffDisputes } = await import("@/lib/admin/disputes");
const { verificationQueue } = await import("@/lib/admin/verification");
const { adminOrganizations } = await import("@/lib/admin/directory");

/** An OPEN dispute on a paid order, per PR #11's flow (mock payment adapters). */
async function openPaidDispute(schedule: "DEPOSIT_30_70" | "NET_30", tag: string) {
  const { OrderRepository } = await import("@packsource/core");
  // The app's adapter singletons — the same instances the admin dispute lib
  // uses, so captured charges are refundable and shipment ids never collide.
  const { payments, tracking, storage } = await import("@/lib/adapters");
  const ports = { payments, tracking, storage };
  const buyerOrders = () => new OrderRepository(prisma, buyerAuth(), ports);
  const supplierOps = () => new OrderRepository(prisma, authFor(supplierOwner, "SUPPLIER_OPS"), ports);

  const order = await awardDraftOrder(`Dispute run ${tag}`, tag);
  const confirmed =
    schedule === "NET_30"
      ? await buyerOrders().confirmOrder(order.id, { paymentSchedule: schedule, net30ApprovedAt: NOW })
      : await buyerOrders().confirmOrder(order.id, { paymentSchedule: schedule });
  if (schedule === "DEPOSIT_30_70") {
    const payments = await prisma.payment.findMany({ where: { orderId: order.id, kind: "DEPOSIT" } });
    await buyerOrders().payScheduledPayment(order.id, payments[0]!.id);
  }
  if (confirmed.status === "IN_PRODUCTION") {
    await supplierOps().completeProduction(order.id);
    const { shipment } = await supplierOps().createShipment(order.id, { carrier: "FedEx" });
    await supplierOps().markShipmentInTransit(shipment.id);
  }
  const dispute = await buyerOrders().openDispute(order.id, `Console mediation run ${tag}`);
  return { order, dispute, buyerOrders, supplierOps };
}

beforeAll(() => {
  execSync("npx prisma migrate deploy", {
    cwd: dbPkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "AuditLog", "Category", "Listing" CASCADE`,
  );
}, 60_000);

beforeAll(async () => {
  const staff = await prisma.user.create({ data: { email: "admin-staff@int.test" } });
  const platformOrg = await prisma.organization.create({
    data: {
      type: "PLATFORM",
      name: "Aekovera Staff (integration)",
      slug: "aekovera-staff-int",
      members: { create: { userId: staff.id, role: "AEKOVERA_STAFF" } },
    },
  });
  staffUser = { id: staff.id, org: { id: platformOrg.id } };

  const buyerUser = await prisma.user.create({ data: { email: "admin-buyer@int.test" } });
  const buyerOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Admin Buyer Co (integration)",
      slug: "admin-buyer-int",
      members: { create: { userId: buyerUser.id, role: "BUYER" } },
    },
  });
  buyer = { id: buyerUser.id, org: { id: buyerOrg.id } };

  const ownerUser = await prisma.user.create({ data: { email: "admin-s-owner@int.test" } });
  const salesUser = await prisma.user.create({ data: { email: "admin-s-sales@int.test" } });
  const supplierOrg = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Admin Supplier One (integration)",
      slug: "admin-supplier-one-int",
      members: {
        create: [
          { userId: ownerUser.id, role: "OWNER" },
          { userId: salesUser.id, role: "SUPPLIER_SALES" },
        ],
      },
      supplierProfile: { create: { verificationStatus: "UNVERIFIED" } },
    },
  });
  supplierOwner = { id: ownerUser.id, org: { id: supplierOrg.id } };
  supplierSales = { id: salesUser.id, org: { id: supplierOrg.id } };

  const category = await prisma.category.create({
    data: { name: "Admin Console Mailers", slug: "admin-console-mailers", attributeSet: {} },
  });
  await prisma.listing.create({
    data: {
      orgId: supplierOrg.id,
      categoryId: category.id,
      title: "Kraft Mailer (admin console)",
      slug: "admin-console-mailer",
      status: "LIVE",
      publishedAt: NOW,
      attributes: {},
    },
  });
});

afterAll(async () => {
  // Order-independent handoff: clear this suite's fixtures so a subsequent
  // suite's count-guarded seed finds an empty graph and reseeds.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "AuditLog", "Category", "Listing" CASCADE`,
  );
  await prisma.$disconnect();
});

describe("permission denials on every admin surface", () => {
  it("denies a buyer every staff action and queue read", async () => {
    const auth = buyerAuth();
    const pendingReview = await prisma.review.findFirst({ where: { moderationStatus: "PENDING" } });
    const membership = await prisma.orgMembership.findFirstOrThrow({
      where: { userId: buyer.id },
    });

    await expect(
      moderateReview(prisma, auth, engineFor(auth), {
        reviewId: "any", decision: "PUBLISHED", now: NOW,
      }),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(
      setVerificationTier(prisma, auth, engineFor(auth), { orgId: "any", tier: "VERIFIED", now: NOW }),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(
      resolveDisputeAsStaff(prisma, auth, engineFor(auth), { disputeId: "any", kind: "RELEASE", now: NOW }),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(
      setMemberRole(prisma, auth, engineFor(auth), { membershipId: membership.id, role: "APPROVER", now: NOW }),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(
      removeMember(prisma, auth, { membershipId: membership.id, now: NOW }),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(moderationQueue(auth)).rejects.toThrow(PermissionDeniedError);
    await expect(staffDisputes(auth, { status: "OPEN" })).rejects.toThrow(PermissionDeniedError);
    await expect(verificationQueue(auth)).rejects.toThrow(PermissionDeniedError);
    await expect(adminOrganizations(auth)).rejects.toThrow(PermissionDeniedError);
    await expect(auditLogPage(auth, {})).rejects.toThrow(PermissionDeniedError);
    expect(pendingReview).toBeNull(); // no fixture reviews exist yet at this point
  });

  it("denies supplier staff the same surfaces", async () => {
    const auth = salesAuth();
    await expect(moderationQueue(auth)).rejects.toThrow(PermissionDeniedError);
    await expect(auditLogPage(auth, {})).rejects.toThrow(PermissionDeniedError);
    await expect(
      setVerificationTier(prisma, auth, engineFor(auth), { orgId: "any", tier: "VERIFIED", now: NOW }),
    ).rejects.toThrow(PermissionDeniedError);
  });
});

describe("review moderation queue", () => {
  it("publishes a pending review with audit before/after and an author notification", async () => {
    const order = await awardDraftOrder("Review moderation run A", "modA");
    const review = await prisma.review.create({
      data: {
        orgId: buyer.org.id,
        supplierOrgId: supplierOwner.org.id,
        authorUserId: buyer.id,
        listingId: (await prisma.listing.findUniqueOrThrow({ where: { slug: "admin-console-mailer" } })).id,
        orderId: order.id,
        qualityRating: 5,
        communicationRating: 4,
        onTimeRating: 5,
        packagingAccuracyRating: 4,
        title: "Great mailers",
        body: "Sturdy, on time.",
      },
    });

    const queue = await moderationQueue(staffAuth());
    expect(queue.map((item) => item.id)).toContain(review.id);

    email.reset();
    const result = await moderateReview(prisma, staffAuth(), engineFor(staffAuth()), {
      reviewId: review.id,
      decision: "PUBLISHED",
      now: NOW,
    });
    expect(result.moderationStatus).toBe("PUBLISHED");

    const updated = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated).toMatchObject({ moderationStatus: "PUBLISHED", moderatedByUserId: staffUser.id });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "review.moderate" } });
    expect(audit).toMatchObject({ entityType: "Review", entityId: review.id, actorUserId: staffUser.id });
    expect((audit.before as { moderationStatus: string }).moderationStatus).toBe("PENDING");
    expect((audit.after as { moderationStatus: string }).moderationStatus).toBe("PUBLISHED");

    // Author notification: in-app row + mock email.
    const authorNotification = await prisma.notification.findFirstOrThrow({
      where: { userId: buyer.id, kind: "REVIEW_MODERATION_DECIDED" },
    });
    expect(authorNotification.linkUrl).toContain(review.orderId);
    expect(email.outbox().map((mail) => mail.to)).toEqual(["admin-buyer@int.test"]);
  });

  it("rejects with a reason that reaches the author notification", async () => {
    const order = await awardDraftOrder("Review moderation run B", "modB");
    const review = await prisma.review.create({
      data: {
        orgId: buyer.org.id,
        supplierOrgId: supplierOwner.org.id,
        authorUserId: buyer.id,
        listingId: (await prisma.listing.findUniqueOrThrow({ where: { slug: "admin-console-mailer" } })).id,
        orderId: order.id,
        qualityRating: 3,
        communicationRating: 3,
        onTimeRating: 3,
        packagingAccuracyRating: 3,
        title: "Meh",
        body: "Contains a promo link: http://spam.example",
      },
    });
    email.reset();
    const result = await moderateReview(prisma, staffAuth(), engineFor(staffAuth()), {
      reviewId: review.id,
      decision: "REJECTED",
      reason: "Contains promotional links",
      now: NOW,
    });
    expect(result.moderationStatus).toBe("REJECTED");
    const updated = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated).toMatchObject({ moderationStatus: "REJECTED", rejectionReason: "Contains promotional links" });
    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: buyer.id, kind: "REVIEW_MODERATION_DECIDED", entityId: review.id },
    });
    expect(notification.body).toContain("promotional links");
  });

  it("refuses to re-decide a decided review", async () => {
    const review = await prisma.review.findFirstOrThrow({ where: { moderationStatus: "PUBLISHED" } });
    await expect(
      moderateReview(prisma, staffAuth(), engineFor(staffAuth()), {
        reviewId: review.id, decision: "REJECTED", reason: "second thoughts", now: NOW,
      }),
    ).rejects.toThrow(ReviewModerationStateError);
  });
});

describe("verification tier changes", () => {
  it("verifies a supplier with audit before/after and notifies OWNER/ADMIN", async () => {
    email.reset();
    const result = await setVerificationTier(prisma, staffAuth(), engineFor(staffAuth()), {
      orgId: supplierOwner.org.id,
      tier: "VERIFIED",
      now: NOW,
    });
    expect(result).toMatchObject({ from: "UNVERIFIED", to: "VERIFIED" });

    const profile = await prisma.supplierProfile.findUniqueOrThrow({
      where: { orgId: supplierOwner.org.id },
    });
    expect(profile).toMatchObject({
      verificationStatus: "VERIFIED",
      verifiedByUserId: staffUser.id,
    });
    expect(profile.verifiedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "supplier.verify" } });
    expect((audit.before as { verificationStatus: string }).verificationStatus).toBe("UNVERIFIED");
    expect((audit.after as { verificationStatus: string }).verificationStatus).toBe("VERIFIED");

    const notified = await prisma.notification.findMany({
      where: { kind: "VERIFICATION_CHANGED", orgId: supplierOwner.org.id },
    });
    // supplierOwner is OWNER; supplierSales is SUPPLIER_SALES and must NOT be notified.
    expect(notified.map((row) => row.userId)).toEqual([supplierOwner.id]);
  });

  it("refuses a same-tier change and clears fields on demotion", async () => {
    await expect(
      setVerificationTier(prisma, staffAuth(), engineFor(staffAuth()), {
        orgId: supplierOwner.org.id, tier: "VERIFIED", now: NOW,
      }),
    ).rejects.toThrow(VerificationStateError);

    await setVerificationTier(prisma, staffAuth(), engineFor(staffAuth()), {
      orgId: supplierOwner.org.id, tier: "UNVERIFIED", now: NOW,
    });
    const profile = await prisma.supplierProfile.findUniqueOrThrow({
      where: { orgId: supplierOwner.org.id },
    });
    expect(profile.verificationStatus).toBe("UNVERIFIED");
    expect(profile.verifiedAt).toBeNull();
    expect(profile.verifiedByUserId).toBeNull();
  });
});

describe("dispute staff resolution — the PR #11 escrow contract", () => {
  it("RELEASE: order releases escrow and pays out exactly as OrderRepository defines", async () => {
    const { order, dispute, buyerOrders, supplierOps } = await openPaidDispute("NET_30", "release");

    // Frozen while open: staff release is refused until the dispute resolves.
    const frozen = await supplierOps().releaseEscrow(order.id);
    expect(frozen).toEqual({ released: false, reason: "dispute-open" });
    expect(await prisma.payout.findMany({ where: { orderId: order.id } })).toHaveLength(0);

    email.reset();
    const result = await resolveDisputeAsStaff(prisma, staffAuth(), engineFor(staffAuth()), {
      disputeId: dispute.id,
      kind: "RELEASE",
      now: NOW,
    });
    expect(result.resolvedTo).toBe("ESCROW_RELEASED");

    const resolvedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(resolvedOrder.status).toBe("ESCROW_RELEASED");
    const disputeRow = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(disputeRow).toMatchObject({
      status: "RESOLVED",
      outcome: "RELEASE_ESCROW",
      resolvedByUserId: staffUser.id,
    });

    // The admin path lands in the same escrow end-state as the repository path:
    // release + commission ledger entries and exactly one supplier payout.
    const ledger = await prisma.escrowLedgerEntry.findMany({ where: { orderId: order.id } });
    expect(ledger.filter((entry) => entry.kind === "RELEASE").length).toBeGreaterThanOrEqual(1);
    expect(ledger.filter((entry) => entry.kind === "COMMISSION").length).toBeGreaterThanOrEqual(1);
    const payouts = await prisma.payout.findMany({ where: { orderId: order.id } });
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.orgId).toBe(supplierOwner.org.id);

    // Single-mode orders carry no subOrder, so the supplier leg is empty —
    // exactly the buyer opener is notified of the resolution.
    const kinds = await prisma.notification.findMany({
      where: { kind: "DISPUTE_RESOLVED", entityId: dispute.id },
    });
    expect(kinds.map((row) => row.userId)).toEqual([buyer.id]);
    expect(email.outbox().map((mail) => mail.to)).toEqual(["admin-buyer@int.test"]);

    // Audit row with the resolution payload — the OrderRepository's audit
    // carries the resolution target in `after.note`.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "dispute.resolve" } });
    expect(audit).toMatchObject({ entityType: "Dispute", entityId: dispute.id, actorUserId: staffUser.id });
    expect((audit.after as { note: string }).note).toBe("ESCROW_RELEASED");

    // The buyer may not use the staff path.
    await expect(
      resolveDisputeAsStaff(prisma, buyerAuth(), engineFor(buyerAuth()), {
        disputeId: dispute.id, kind: "RELEASE", now: NOW,
      }),
    ).rejects.toThrow(PermissionDeniedError);
    void buyerOrders;
  });

  it("FULL_REFUND: paid deposit is refunded and the order cancels", async () => {
    const { order, dispute } = await openPaidDispute("DEPOSIT_30_70", "refund");

    const result = await resolveDisputeAsStaff(prisma, staffAuth(), engineFor(staffAuth()), {
      disputeId: dispute.id,
      kind: "FULL_REFUND",
      note: "Deposited funds refunded in full",
      now: NOW,
    });
    expect(result.resolvedTo).toBe("CANCELLED");

    const resolvedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(resolvedOrder.status).toBe("CANCELLED");
    const ledger = await prisma.escrowLedgerEntry.findMany({ where: { orderId: order.id } });
    expect(ledger.some((entry) => entry.kind === "REFUND")).toBe(true);
    const disputeRow = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(disputeRow.status).toBe("RESOLVED");
  });

  it("BACK_TO_DELIVERED: order resumes the delivered state without refund or release", async () => {
    const { order, dispute } = await openPaidDispute("NET_30", "back");

    const result = await resolveDisputeAsStaff(prisma, staffAuth(), engineFor(staffAuth()), {
      disputeId: dispute.id,
      kind: "BACK_TO_DELIVERED",
      now: NOW,
    });
    expect(result.resolvedTo).toBe("DELIVERED");
    const resolvedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(resolvedOrder.status).toBe("DELIVERED");
    // Still frozen for release (no dispute open anymore, but escrow untouched).
    expect(await prisma.payout.findMany({ where: { orderId: order.id } })).toHaveLength(0);
    expect(await prisma.escrowLedgerEntry.findMany({ where: { orderId: order.id, kind: "REFUND" } })).toHaveLength(0);
  });
});

describe("membership administration", () => {
  it("changes a member role with audit and notification; refuses staff self-grant", async () => {
    const membership = await prisma.orgMembership.findFirstOrThrow({
      where: { userId: supplierSales.id },
    });
    email.reset();
    const result = await setMemberRole(prisma, staffAuth(), engineFor(staffAuth()), {
      membershipId: membership.id,
      role: "SUPPLIER_OPS",
      now: NOW,
    });
    expect(result).toMatchObject({ from: "SUPPLIER_SALES", to: "SUPPLIER_OPS" });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "org.membership.role_changed" } });
    expect((audit.after as { role: string }).role).toBe("SUPPLIER_OPS");

    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: supplierSales.id, kind: "ORG_ROLE_CHANGED" },
    });
    expect(notification.body).toContain("SUPPLIER_OPS");

    // The staff role is never assignable from the console (no self-promotion).
    await expect(
      setMemberRole(prisma, staffAuth(), engineFor(staffAuth()), {
        membershipId: membership.id, role: "AEKOVERA_STAFF", now: NOW,
      }),
    ).rejects.toThrow();
  });

  it("removes a member with audit", async () => {
    const membership = await prisma.orgMembership.findFirstOrThrow({
      where: { userId: supplierSales.id },
    });
    const result = await removeMember(prisma, staffAuth(), { membershipId: membership.id, now: NOW });
    expect(result.userId).toBe(supplierSales.id);
    expect(await prisma.orgMembership.findUnique({ where: { id: membership.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "org.membership.removed" } });
    expect(audit).toMatchObject({ entityType: "OrgMembership", entityId: membership.id });
  });
});

describe("audit log viewer filters", () => {
  it("filters by action prefix, entity type, and actor email", async () => {
    const auth = staffAuth();
    const reviewRows = await auditLogPage(auth, { actionPrefix: "review." });
    expect(reviewRows.rows.length).toBeGreaterThanOrEqual(2);
    expect(reviewRows.rows.every((row) => row.action.startsWith("review."))).toBe(true);

    const disputeRows = await auditLogPage(auth, { entity: "Dispute" });
    expect(disputeRows.rows.length).toBeGreaterThanOrEqual(3);
    expect(disputeRows.rows.every((row) => row.entityType === "Dispute")).toBe(true);

    const staffRows = await auditLogPage(auth, { actorEmail: "admin-staff@int.test" });
    expect(staffRows.rows.length).toBeGreaterThanOrEqual(1);
    expect(staffRows.actorEmails[staffUser.id]).toBe("admin-staff@int.test");
    expect(staffRows.rows.every((row) => row.actorUserId === staffUser.id)).toBe(true);
  });

  it("filters by date range deterministically", async () => {
    const auth = staffAuth();
    const page = await auditLogPage(auth, { from: "2026-05-10", to: "2026-05-10" });
    for (const row of page.rows) {
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(new Date("2026-05-10T00:00:00.000Z").getTime());
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(new Date("2026-05-10T23:59:59.999Z").getTime());
    }
    const none = await auditLogPage(auth, { from: "2020-01-01", to: "2020-01-02" });
    expect(none.rows).toEqual([]);
  });

  it("resolves a deleted actor's email to null without breaking the row", async () => {
    const auth = staffAuth();
    const ghost = await prisma.user.create({ data: { email: "admin-ghost@int.test" } });
    await prisma.auditLog.create({
      data: {
        orgId: staffUser.org.id,
        actorUserId: ghost.id,
        actorType: "user",
        action: "review.moderate",
        entityType: "Review",
        entityId: "ghost",
        after: {},
      },
    });
    await prisma.user.delete({ where: { id: ghost.id } });
    const rows = await auditLogPage(auth, { actorEmail: "admin-ghost@int.test" });
    // No user row matches the email anymore -> explicit empty result (never an unfiltered dump).
    expect(rows.rows).toEqual([]);
  });
});
