import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import { MockPaymentsAdapter, MockStorageAdapter, MockTrackingAdapter } from "@packsource/ai";
import {
  CartRepository,
  OrderRepository,
  OrderWorkflowError,
  PermissionDeniedError,
  QuoteRepository,
  RfqRepository,
  splitDeposit,
  type AuthContext,
} from "../../src/index";

/**
 * End-to-end order lifecycle against a real pgvector Postgres:
 * award → DRAFT order → confirm (schedule selection) → mock Stripe Connect
 * payment → escrow hold → production → balance invoice → shipment →
 * delivery → idempotent escrow release → payout rows — with every audit
 * event, exact integer-cent amount, permission gate, dispute freeze, and
 * Net-30 rule asserted on the way through.
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
let s1ops!: { id: string; org: { id: string } };
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
const otherBuyerOrders = () => ordersAs(otherBuyer, "BUYER");
const s1OpsOrders = () => ordersAs(s1ops, "SUPPLIER_OPS");
const staffOrders = () => ordersAs(staff, "AEKOVERA_STAFF");

/** SINGLE-mode RFQ on Supplier One's listing, quoted and awarded to the buyer. */
async function awardDraftOrder(title: string, emailTag: string) {
  const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "orders-flow-mailer" } });
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
    message: `Quote ${emailTag} — happy to run this on the 12-day turnaround.`,
  });
  await new CartRepository(prisma, authFor(buyer, "BUYER")).addToCart(quote.id);
  const { order } = await new CartRepository(prisma, authFor(buyer, "BUYER")).acceptQuote(quote.id);
  return order;
}

const auditsFor = async (orgId: string) =>
  (await prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } })).map((row) => row.action);

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
  const buyerUser = await prisma.user.create({ data: { email: "orders-buyer@int.test" } });
  const buyerOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Orders Buyer Co (integration)",
      slug: "orders-buyer-int",
      members: { create: { userId: buyerUser.id, role: "BUYER" } },
    },
  });
  buyer = { id: buyerUser.id, org: { id: buyerOrg.id } };

  const otherUser = await prisma.user.create({ data: { email: "orders-other@int.test" } });
  const otherOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Unrelated Buyer Co (integration)",
      slug: "orders-unrelated-int",
      members: { create: { userId: otherUser.id, role: "BUYER" } },
    },
  });
  otherBuyer = { id: otherUser.id, org: { id: otherOrg.id } };

  const salesUser = await prisma.user.create({ data: { email: "orders-s1-sales@int.test" } });
  const opsUser = await prisma.user.create({ data: { email: "orders-s1-ops@int.test" } });
  const s1Org = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Orders Supplier One (integration)",
      slug: "orders-supplier-one-int",
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

  const staffUser = await prisma.user.create({ data: { email: "orders-staff@int.test" } });
  const platformOrg = await prisma.organization.create({
    data: {
      type: "PLATFORM",
      name: "Aekovera (orders integration)",
      slug: "aekovera-orders-int",
      members: { create: { userId: staffUser.id, role: "AEKOVERA_STAFF" } },
    },
  });
  staff = { id: staffUser.id, org: { id: platformOrg.id } };

  const category = await prisma.category.create({
    data: { name: "Orders Flow Mailers", slug: "orders-flow-mailers", attributeSet: {} },
  });
  await prisma.listing.create({
    data: {
      orgId: s1Org.id,
      categoryId: category.id,
      title: "Kraft Mailer (orders flow)",
      slug: "orders-flow-mailer",
      status: "LIVE",
      publishedAt: new Date(),
      attributes: {},
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("order lifecycle: award → payment → shipment → delivery → escrow release → payout", () => {
  it("runs the DEPOSIT_30_70 golden path with exact integer-cent money and audits", async () => {
    // ── award: quote cart acceptance creates the DRAFT order ────────────────
    const order = await awardDraftOrder("1,000 kraft mailers, repeat program", "A");
    expect(order.status).toBe("DRAFT");
    expect(order.orgId).toBe(buyer.org.id);
    // 42,000 line + 15,000 tooling + 5,000 plates + 15,000 freight = 77,000 exactly.
    expect(order.totalCents).toBe(77_000);

    // ── confirm: schedule selection schedules the 30/70 legs + pro-forma ────
    const confirmed = await buyerOrders().confirmOrder(order.id, { paymentSchedule: "DEPOSIT_30_70" });
    expect(confirmed.status).toBe("DEPOSIT_DUE");
    const { depositCents, balanceCents } = splitDeposit(77_000);
    expect(depositCents).toBe(23_100);
    expect(balanceCents).toBe(53_900);

    // Only the upfront DEPOSIT leg exists at placement; the BALANCE leg is
    // scheduled when the balance invoice is issued at production complete.
    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(1);
    const deposit = payments[0]!;
    expect(deposit.kind).toBe("DEPOSIT");
    expect(deposit.amountCents).toBe(23_100);
    expect(deposit.status).toBe("PENDING");

    const proForma = await prisma.invoice.findFirstOrThrow({ where: { orderId: order.id, kind: "PRO_FORMA" } });
    expect(proForma.totalCents).toBe(77_000);
    expect(proForma.pdfFileId).toBeTruthy();

    // ── pay the deposit: mock capture lands in the platform's escrow ────────
    await buyerOrders().payScheduledPayment(order.id, deposit.id);
    const afterDeposit = await prisma.escrowLedgerEntry.findMany({ where: { orderId: order.id } });
    expect(afterDeposit.filter((e) => e.kind === "HOLD")).toHaveLength(1);
    expect(afterDeposit.find((e) => e.kind === "HOLD")?.amountCents).toBe(23_100);

    // Idempotent replay: paying a captured payment is a no-op.
    const replayed = await buyerOrders().payScheduledPayment(order.id, deposit.id);
    expect(replayed.id).toBe(deposit.id);
    const afterReplay = await prisma.escrowLedgerEntry.findMany({ where: { orderId: order.id } });
    expect(afterReplay).toHaveLength(1);

    // ── production ──────────────────────────────────────────────────────────
    await s1OpsOrders().startProduction(order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("IN_PRODUCTION");

    await s1OpsOrders().completeProduction(order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("READY_TO_SHIP");

    // Supplier issues the balance invoice (ISSUE_BALANCE) — the BALANCE leg
    // and its commercial invoice are scheduled by that step.
    await s1OpsOrders().issueBalanceInvoice(order.id);
    const afterComplete = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterComplete.status).toBe("BALANCE_DUE");
    const balanceInvoice = await prisma.invoice.findFirstOrThrow({
      where: { orderId: order.id, kind: { not: "PRO_FORMA" } },
    });
    expect(balanceInvoice.totalCents).toBe(53_900);
    const balance = await prisma.payment.findFirstOrThrow({
      where: { orderId: order.id, kind: "BALANCE" },
    });
    expect(balance.amountCents).toBe(53_900);
    expect(balance.status).toBe("PENDING");

    // ── pay the balance: escrow now holds the full 77,000 ───────────────────
    await buyerOrders().payScheduledPayment(order.id, balance.id);
    const holds = await prisma.escrowLedgerEntry.findMany({
      where: { orderId: order.id, kind: "HOLD" },
    });
    expect(holds).toHaveLength(2);
    expect(holds.reduce((sum, e) => sum + e.amountCents, 0)).toBe(77_000);

    // ── ship ────────────────────────────────────────────────────────────────
    const created = await s1OpsOrders().createShipment(order.id, { carrier: "UPS" });
    const shipment = created.shipment;
    expect(shipment.status).toBe("CREATED");
    expect(shipment.trackingNumber).toBeTruthy();

    await s1OpsOrders().markShipmentInTransit(shipment.id);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("IN_TRANSIT");

    // ── deliver → escrow releases inline → payout rows appear ───────────────
    await s1OpsOrders().confirmDelivery(shipment.id);
    const delivered = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(delivered.status).toBe("ESCROW_RELEASED");

    const entries = await prisma.escrowLedgerEntry.findMany({ where: { orderId: order.id } });
    const release = entries.find((e) => e.kind === "RELEASE");
    const commission = entries.find((e) => e.kind === "COMMISSION");
    expect(commission?.amountCents).toBe(3_850); // 5% of 77,000
    expect(release?.amountCents).toBe(73_150); // 77,000 − 3,850
    // The ledger balances: holds out, release + commission + holds returned... net zero.
    const holdsAfter = entries.filter((e) => e.kind === "HOLD");
    const refundOrReversal = entries.filter((e) => e.kind !== "HOLD" && e.kind !== "RELEASE" && e.kind !== "COMMISSION");
    expect(holdsAfter.reduce((s, e) => s + e.amountCents, 0)).toBe(77_000);
    expect(release!.amountCents + commission!.amountCents + refundOrReversal.reduce((s, e) => s + e.amountCents, 0)).toBe(77_000);

    const payouts = await prisma.payout.findMany({ where: { orderId: order.id } });
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      orgId: s1ops.org.id,
      amountCents: 77_000,
      commissionCents: 3_850,
      netCents: 73_150,
      status: "PENDING",
    });

    const podShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(podShipment.status).toBe("DELIVERED");
    expect(podShipment.podFileId).toBeTruthy();

    // ── idempotent release: a second sweep is a no-op ───────────────────────
    const secondRelease = await s1OpsOrders().releaseEscrow(order.id);
    expect(secondRelease.released).toBe(false);
    expect(await prisma.escrowLedgerEntry.findMany({ where: { orderId: order.id } })).toHaveLength(entries.length);
    expect(await prisma.payout.findMany({ where: { orderId: order.id } })).toHaveLength(1);

    // ── settlement: staff settles the mock Connect transfer ─────────────────
    const settled = await staffOrders().settlePayout(payouts[0]!.id);
    expect(settled.status).toBe("PAID");
    expect(settled.stripeTransferId).toBeTruthy();
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payouts[0]!.id } })).status).toBe("PAID");

    // ── audit events at every step (user actions in the acting org) ─────────
    const buyerAudits = await auditsFor(buyer.org.id);
    expect(buyerAudits).toEqual(expect.arrayContaining(["order.place", "payment.captured", "invoice.issued"]));
    const supplierAudits = await auditsFor(s1ops.org.id);
    expect(supplierAudits).toEqual(
      expect.arrayContaining([
        "order.production_start",
        "order.production_complete",
        "order.balance_issued",
        "shipment.created",
        "shipment.in_transit",
        "shipment.delivered",
        "escrow.release",
        "payout.created",
      ]),
    );
    const staffAudits = await auditsFor(staff.org.id);
    expect(staffAudits).toContain("payout.settled");
  });

  it("denies cross-org order, payment, and invoice access", async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { orgId: buyer.org.id } });

    // Unrelated buyer cannot read the order…
    await expect(otherBuyerOrders().getOrder(order.id)).rejects.toThrow(OrderWorkflowError);
    // …cannot pay against it (scoped to the buyer org)…
    const deposit = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, kind: "DEPOSIT" } });
    await expect(otherBuyerOrders().payScheduledPayment(order.id, deposit.id)).rejects.toThrow(OrderWorkflowError);
    // …cannot read its invoices…
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { orderId: order.id } });
    await expect(otherBuyerOrders().getInvoicePdfUrl(order.id, invoice.id)).rejects.toThrow(OrderWorkflowError);
    // …and buyers have no payout visibility at all.
    await expect(otherBuyerOrders().listPayouts()).rejects.toThrow(PermissionDeniedError);

    // Supplier ledger visibility is scoped to its own legs.
    const supplierPayouts = await ordersAs(s1ops, "SUPPLIER_OPS").listPayouts();
    expect(supplierPayouts.length).toBeGreaterThanOrEqual(1);
    for (const payout of supplierPayouts) {
      expect(payout.orgId).toBe(s1ops.org.id);
    }
    // Staff sees the full ledger.
    const staffPayouts = await staffOrders().listPayouts();
    expect(staffPayouts.length).toBeGreaterThanOrEqual(supplierPayouts.length);
  });

  it("freezes escrow while a dispute is open and releases after mediation (Net-30 path)", async () => {
    const order = await awardDraftOrder("1,000 kraft mailers, dispute run", "B");

    // Net-30 requires a staff approval timestamp up front.
    await expect(buyerOrders().confirmOrder(order.id, { paymentSchedule: "NET_30" })).rejects.toThrow();
    const confirmed = await buyerOrders().confirmOrder(order.id, {
      paymentSchedule: "NET_30",
      net30ApprovedAt: new Date(),
    });
    expect(confirmed.status).toBe("IN_PRODUCTION"); // NET_30 places straight into production

    await s1OpsOrders().completeProduction(order.id);
    const shipment = (await s1OpsOrders().createShipment(order.id, { carrier: "FedEx" })).shipment;
    await s1OpsOrders().markShipmentInTransit(shipment.id);
    const shipped = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(shipped.status).toBe("SHIPPED");

    // The receivable invoice exists with a deterministic Net-30 due date.
    const receivable = await prisma.invoice.findFirstOrThrow({
      where: { orderId: order.id, kind: { not: "PRO_FORMA" } },
    });
    expect(receivable.totalCents).toBe(77_000);
    expect(receivable.dueAt).toBeTruthy();

    // Buyer opens a dispute → order freezes at DISPUTED.
    const dispute = await buyerOrders().openDispute(order.id, "Wrong print color on half the run");
    expect(dispute.status).toBe("OPEN");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DISPUTED");

    // Escrow release is refused while the dispute is open.
    const frozen = await s1OpsOrders().releaseEscrow(order.id);
    expect(frozen).toEqual({ released: false, reason: "dispute-open" });
    expect(await prisma.payout.findMany({ where: { orderId: order.id } })).toHaveLength(0);

    // Mediation: staff resolves with release → escrow releases → payouts appear.
    await staffOrders().resolveDispute(order.id, dispute.id, { type: "RELEASE" });
    const resolved = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(resolved.status).toBe("ESCROW_RELEASED");
    const payouts = await prisma.payout.findMany({ where: { orderId: order.id } });
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ orgId: s1ops.org.id, netCents: 73_150 });

    const disputeAudits = await auditsFor(buyer.org.id);
    expect(disputeAudits).toContain("dispute.open");
    const staffAudits = await auditsFor(staff.org.id);
    expect(staffAudits).toContain("dispute.resolve");
  });
});
