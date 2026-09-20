/**
 * Audited order workflow repository (spec: "Order and escrow lifecycle",
 * "Escrow payments" acceptance). Every state move goes through the pure
 * machine first; money moves only after the transition is accepted; every
 * movement writes an append-only EscrowLedgerEntry with a deterministic
 * idempotency key. Cross-org access is refused; buyer, supplier, and staff
 * routes are permission-gated.
 */
import { Prisma, type PrismaClient, type EscrowEntryKind } from "@packsource/db";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";
import { EscrowError, commissionSplit, escrowBalance, escrowKeys, releaseDecision } from "./escrow";
import { assertNet30Approved, balancePlan, net30DueAt, upfrontPlan } from "./payment-schedule";
import { orderTransition, type OrderSnapshot } from "./order-machine";
import type { OrderPaymentsPort, OrderStoragePort } from "./ports";

/** Audit action names for the order lifecycle (AuditLog is append-only). */
export const ORDER_AUDIT = {
  place: "order.place",
  scheduleSet: "order.schedule_set",
  paymentScheduled: "payment.scheduled",
  paymentCaptured: "payment.captured",
  paymentFailed: "payment.failed",
  productionStart: "order.production_start",
  productionComplete: "order.production_complete",
  balanceIssued: "order.balance_issued",
  ship: "order.ship",
  deliver: "order.deliver",
  escrowRelease: "escrow.release",
  payoutCreated: "payout.created",
  payoutSettled: "payout.settled",
  cancel: "order.cancel",
  disputeOpen: "dispute.open",
  disputeResolve: "dispute.resolve",
  refundIssued: "refund.issued",
  invoiceIssued: "invoice.issued",
  invoicePaid: "invoice.paid",
  shipmentCreated: "shipment.created",
  shipmentInTransit: "shipment.in_transit",
  shipmentDelivered: "shipment.delivered",
} as const;

/** Raised for workflow violations the machine and schema cannot express. */
export class OrderWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderWorkflowError";
  }
}

/** The order row plus the state the machine needs alongside it. */
type OrderRow = Prisma.OrderGetPayload<{ include: { subOrders: true; orderLines: true } }>; // prettier-ignore-line

export class OrderRepository {
  readonly #db: PrismaClient;
  readonly #auth: AuthContext;
  readonly #payments: OrderPaymentsPort;
  readonly #storage: OrderStoragePort;

  constructor(
    db: PrismaClient,
    auth: AuthContext,
    ports: { payments: OrderPaymentsPort; storage: OrderStoragePort },
  ) {
    this.#db = db;
    this.#auth = auth;
    this.#payments = ports.payments;
    this.#storage = ports.storage;
  }

  #require(permission: Permission): void {
    assertCan(this.#auth.role, permission);
  }

  async #audit(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
    note?: string,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId: this.#auth.orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType,
        entityId,
        ...(note ? { after: { note } as Prisma.InputJsonValue } : {}),
      },
    });
  }

  // ── loading & scoping ─────────────────────────────────────────────────────

  /** Load an order with its money/fulfillment graph, refusing cross-org reads. */
  async getOrder(orderId: string) {
    const order = await this.#db.order.findUnique({
      where: { id: orderId },
      include: {
        orderLines: true,
        subOrders: true,
        payments: { orderBy: { createdAt: "asc" } },
        invoices: { orderBy: { createdAt: "asc" } },
        payouts: { orderBy: { createdAt: "asc" } },
        escrowEntries: { orderBy: { occurredAt: "asc" } },
        disputes: { orderBy: { createdAt: "asc" } },
        refunds: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!order) {
      throw new RecordNotFoundError("Order", orderId);
    }
    const isBuyer = order.orgId === this.#auth.orgId;
    const isSupplier = order.subOrders.some((sub) => sub.orgId === this.#auth.orgId);
    const isStaff = this.#auth.role === "AEKOVERA_STAFF";
    if (!isBuyer && !isSupplier && !isStaff) {
      throw new OrderWorkflowError(`organization ${this.#auth.orgId} may not access order ${orderId}`);
    }
    return order;
  }

  /** Orders the acting buyer org placed. */
  async listBuyerOrders() {
    return this.#db.order.findMany({
      where: { orgId: this.#auth.orgId },
      orderBy: { createdAt: "desc" },
      include: { payments: true, subOrders: true, disputes: { where: { status: { in: ["OPEN", "UNDER_REVIEW"] } } } },
    });
  }

  /** Orders with a fulfillment leg owned by the acting supplier org. */
  async listSupplierOrders() {
    return this.#db.order.findMany({
      where: { subOrders: { some: { orgId: this.#auth.orgId } } },
      orderBy: { createdAt: "desc" },
      include: { payments: true, subOrders: true, disputes: { where: { status: { in: ["OPEN", "UNDER_REVIEW"] } } } },
    });
  }

  // ── machine plumbing ──────────────────────────────────────────────────────

  /** Snapshot the machine state from the order and its payments/disputes. */
  #snapshot(order: OrderRow, payments: { kind: string; status: string }[], openDisputeId: string | null): OrderSnapshot {
    const balancePaid =
      payments.some((p) => p.kind === "BALANCE" && p.status === "SUCCEEDED") ||
      order.paymentSchedule === "FULL_PREPAY";
    return {
      status: order.status,
      paymentSchedule: order.paymentSchedule,
      balancePaid,
      openDisputeId,
    };
  }

  /**
   * Accept a machine transition inside a transaction, persist the new status
   * (plus timestamp columns), and audit it. Stripe calls happen only after
   * this is accepted (spec: "Stripe calls happen only after the transition
   * is accepted").
   */
  async #transition(
    tx: Prisma.TransactionClient,
    order: OrderRow,
    payments: { kind: string; status: string }[],
    openDisputeId: string | null,
    event: Parameters<typeof orderTransition>[1],
    extraData?: Prisma.OrderUpdateInput,
  ): Promise<OrderRow> {
    const snapshot = this.#snapshot(order, payments, openDisputeId);
    const [plan] = orderTransition(snapshot, event);
    if (!plan) {
      throw new OrderWorkflowError(`transition ${event.type} produced no plan for order ${order.id}`);
    }
    const at = event.at;
    const timestampData: Prisma.OrderUpdateInput = {};
    if (plan.to === "CANCELLED") {
      timestampData.cancelledAt = at;
      timestampData.cancellationReason = "Cancelled by workflow";
    }
    if (plan.to === "CLOSED") {
      timestampData.closedAt = at;
    }
    if (event.type === "PLACE") {
      timestampData.placedAt = at;
    }
    const updated = await tx.order.update({
      where: { id: order.id },
      data: { status: plan.to, ...timestampData, ...extraData },
      include: { subOrders: true, orderLines: true },
    });
    await this.#audit(tx, event.type, "Order", order.id, `${order.status} -> ${plan.to}`);
    return updated;
  }

  // ── buyer: place & pay ────────────────────────────────────────────────────

  /**
   * Buyer confirms the DRAFT order: chooses the schedule (Net-30 requires a
   * staff approval timestamp), opens the fulfillment leg, schedules the
   * upfront payment(s) per the spec, and issues the pro-forma invoice.
   */
  async confirmOrder(
    orderId: string,
    input: { paymentSchedule: "FULL_PREPAY" | "DEPOSIT_30_70" | "NET_30"; net30ApprovedAt?: Date },
  ) {
    this.#require("order:create");
    const at = new Date();
    return this.#db.$transaction(async (tx) => {
      const order = await this.#loadForUpdate(tx, orderId);
      if (order.status !== "DRAFT") {
        throw new OrderWorkflowError(`order ${orderId} is not a draft (status ${order.status})`);
      }
      if (input.paymentSchedule === "NET_30") {
        assertNet30Approved(input.net30ApprovedAt ?? null);
      }

      // Machine first: PLACE routes by schedule (NET_30 skips deposit legs).
      const updated = await this.#transition(
        tx,
        order,
        [],
        null,
        { type: "PLACE", at },
        {
          paymentSchedule: input.paymentSchedule,
          ...(input.net30ApprovedAt
            ? { net30ApprovedAt: input.net30ApprovedAt, net30ApprovedByUserId: this.#auth.userId }
            : {}),
        },
      );

      // Fulfillment leg (one per supplier for a single-award order).
      const supplierOrgId = order.orderLines[0]?.orgId;
      if (!supplierOrgId) {
        throw new OrderWorkflowError(`order ${orderId} has no order lines to fulfill`);
      }
      const existingSub = await tx.subOrder.findFirst({ where: { orderId, orgId: supplierOrgId } });
      const subOrder =
        existingSub ??
        (await tx.subOrder.create({
          data: {
            orderId,
            orgId: supplierOrgId,
            subtotalCents: order.subtotalCents,
            toolingCents: order.toolingCents,
            plateChargesCents: order.plateChargesCents,
            freightCents: order.freightCents,
            totalCents: order.totalCents,
            commissionBps: order.commissionBps,
          },
        }));

      // Upfront payment milestones per schedule (idempotent by key).
      const milestones = upfrontPlan(input.paymentSchedule, order.totalCents, at);
      for (const milestone of milestones) {
        await this.#schedulePayment(tx, updated, milestone.kind, milestone.amountCents, milestone.dueAt);
      }

      // Pro-forma invoice covering the upfront leg (if any).
      if (milestones.length > 0) {
        await this.#issueInvoice(
          tx,
          updated,
          subOrder.id,
          "PRO_FORMA",
          order.totalCents,
          "Pro-forma — due on placement",
          at,
        );
      }
      await this.#audit(tx, ORDER_AUDIT.place, "Order", orderId, `schedule ${input.paymentSchedule}`);
      return updated;
    });
  }

  /**
   * Buyer pays a scheduled payment: machine-accept, mock-capture, escrow
   * hold, invoice settlement, audits. Replays are no-ops (SUCCEEDED rows
   * short-circuit; unique idempotency keys block double rows).
   */
  async payScheduledPayment(orderId: string, paymentId: string) {
    this.#require("order:create");
    const at = new Date();
    return this.#db.$transaction(async (tx) => {
      const order = await this.#loadForUpdate(tx, orderId);
      const payment = await tx.payment.findFirst({ where: { id: paymentId, orderId } });
      if (!payment || payment.orgId !== order.orgId) {
        throw new RecordNotFoundError("Payment", paymentId);
      }
      if (payment.status === "SUCCEEDED") {
        return payment; // idempotent replay — already captured
      }
      if (payment.status !== "PENDING" && payment.status !== "FAILED") {
        throw new OrderWorkflowError(`payment ${paymentId} is ${payment.status}, not payable`);
      }

      const disputes = await tx.dispute.findFirst({ where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } } });
      const openDisputeId = disputes?.id ?? null;

      // Deposit legs move the machine; balance/full legs only settle money.
      const movesMachine =
        (payment.kind === "DEPOSIT" || payment.kind === "FULL") && order.status === "DEPOSIT_DUE";
      const current = movesMachine
        ? await this.#transition(tx, order, [payment], openDisputeId, { type: "PAY_DEPOSIT", at })
        : order;

      // Mock capture (deterministic; zero API keys). Failure is recorded,
      // not swallowed — the payment row keeps FAILED and the error rethrows.
      let succeeded: { id: string } | null = null;
      try {
        const charge = await this.#payments.captureCharge({
          amountCents: payment.amountCents,
          currency: "usd",
          metadata: { orderId, paymentId, idempotencyKey: payment.idempotencyKey },
        });
        succeeded = charge;
      } catch (error) {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: "FAILED", failureReason: error instanceof Error ? error.message : "capture failed" },
        });
        await this.#audit(tx, ORDER_AUDIT.paymentFailed, "Payment", paymentId);
        throw error;
      }

      const captured = await tx.payment.update({
        where: { id: paymentId },
        data: { status: "SUCCEEDED", paidAt: at, stripePaymentIntentId: succeeded.id },
      });
      await this.#audit(tx, ORDER_AUDIT.paymentCaptured, "Payment", paymentId, `${payment.amountCents}c`);

      // Escrow hold — platform-held funds (spec: "Funds are captured at
      // checkout to the platform's Stripe account").
      await this.#escrowEntry(tx, order, {
        kind: "HOLD",
        amountCents: payment.amountCents,
        idempotencyKey: escrowKeys.hold(paymentId),
        stripeRef: succeeded.id,
        paymentId,
        occurredAt: at,
      });

      // Settle the linked invoice, if the leg had one.
      if (payment.invoiceId) {
        await tx.invoice.update({
          where: { id: payment.invoiceId },
          data: { status: "PAID", paidAt: at },
        });
        await this.#audit(tx, ORDER_AUDIT.invoicePaid, "Invoice", payment.invoiceId);
      }

      // Balance legs mark the machine's balancePaid via the payments query;
      // audit the schedule for Net-30 receivables.
      if (payment.kind === "BALANCE") {
        await this.#audit(tx, ORDER_AUDIT.balanceIssued, "Order", current.id, "balance paid");
      }
      return captured;
    });
  }

  /** Buyer opens a dispute — freezes escrow release (spec: "disputes freeze transfers"). */
  async openDispute(orderId: string, reason: string) {
    this.#require("order:create");
    const at = new Date();
    return this.#db.$transaction(async (tx) => {
      const order = await this.#loadForUpdate(tx, orderId);
      const payments = await tx.payment.findMany({ where: { orderId, status: "SUCCEEDED" } });
      const existing = await tx.dispute.findFirst({ where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } } });
      const dispute = await tx.dispute.create({
        data: { orderId, orgId: this.#auth.orgId, openedByUserId: this.#auth.userId, reason },
      });
      await this.#transition(tx, order, payments, existing?.id ?? dispute.id, { type: "OPEN_DISPUTE", at });
      await this.#audit(tx, ORDER_AUDIT.disputeOpen, "Dispute", dispute.id, reason);
      return dispute;
    });
  }

  /** Buyer cancels before production; refund per schedule (spec). */
  async cancelOrder(orderId: string, reason: string) {
    this.#require("order:create");
    const at = new Date();
    return this.#db.$transaction(async (tx) => {
      const order = await this.#loadForUpdate(tx, orderId);
      const payments = await tx.payment.findMany({ where: { orderId, status: "SUCCEEDED" } });
      const updated = await this.#transition(tx, order, payments, null, { type: "CANCEL", at });
      for (const payment of payments) {
        await this.#refundPaymentRow(tx, updated, payment.id, payment.amountCents, reason, at);
      }
      await this.#audit(tx, ORDER_AUDIT.cancel, "Order", orderId, reason);
      return updated;
    });
  }

  // ── supplier: production & fulfillment ────────────────────────────────────

  /** Supplier confirms the fulfillment leg and starts production. */
  async startProduction(orderId: string) {
    this.#require("shipment:manage");
    const at = new Date();
    return this.#db.$transaction(async (tx) => {
      const { order, subOrder } = await this.#loadSupplierLeg(tx, orderId);
      const payments = await tx.payment.findMany({ where: { orderId, status: "SUCCEEDED" } });
      const disputes = await tx.dispute.findFirst({ where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } } });
      const updated = await this.#transition(tx, order, payments, disputes?.id ?? null, {
        type: "START_PRODUCTION",
        at,
      });
      await tx.subOrder.update({ where: { id: subOrder.id }, data: { status: "IN_PRODUCTION" } });
      await this.#audit(tx, ORDER_AUDIT.productionStart, "Order", orderId);
      return updated;
    });
  }

  /** Supplier finishes production; the order waits at ready-to-ship. */
  async completeProduction(orderId: string) {
    this.#require("shipment:manage");
    const at = new Date();
    return this.#db.$transaction(async (tx) => {
      const { order, subOrder } = await this.#loadSupplierLeg(tx, orderId);
      const payments = await tx.payment.findMany({ where: { orderId, status: "SUCCEEDED" } });
      const disputes = await tx.dispute.findFirst({ where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } } });
      const updated = await this.#transition(tx, order, payments, disputes?.id ?? null, {
        type: "COMPLETE_PRODUCTION",
        at,
      });
      await tx.subOrder.update({ where: { id: subOrder.id }, data: { status: "READY_TO_SHIP" } });
      await this.#audit(tx, ORDER_AUDIT.productionComplete, "Order", orderId);
      return updated;
    });
  }

  /**
   * Issue the balance leg: 30/70 invoices at ready-to-ship (before
   * shipment), Net-30 invoices on shipment with a deterministic due date
   * (spec: "balance invoiced before shipment", "Net-30 ... invoices on
   * shipment and charges off-session on the due date").
   */
  async issueBalanceInvoice(orderId: string, issuedAt: Date = new Date()) {
    this.#require("shipment:manage");
    return this.#db.$transaction(async (tx) => {
      const { order, subOrder } = await this.#loadSupplierLeg(tx, orderId);
      const payments = await tx.payment.findMany({ where: { orderId } });
      const disputes = await tx.dispute.findFirst({ where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } } });
      const existingBalance = payments.find((p) => p.kind === "BALANCE");
      if (existingBalance) {
        return existingBalance; // idempotent — the balance leg already exists
      }
      if (order.paymentSchedule === "FULL_PREPAY") {
        throw new OrderWorkflowError(`order ${orderId} is fully prepaid — no balance leg`);
      }

      const snapshot = this.#snapshot(order, payments, disputes?.id ?? null);
      const shipment = await tx.shipment.findFirst({ where: { subOrderId: subOrder.id }, orderBy: { createdAt: "asc" } });
      const shippedAt = order.paymentSchedule === "NET_30" ? (shipment?.shippedAt ?? null) : null;
      if (order.paymentSchedule === "DEPOSIT_30_70") {
        await this.#transition(tx, order, payments, disputes?.id ?? null, { type: "ISSUE_BALANCE", at: issuedAt });
      } else if (order.paymentSchedule !== "NET_30" || snapshot.status !== "SHIPPED") {
        throw new OrderWorkflowError(
          `balance not issuable for order ${orderId} on schedule ${order.paymentSchedule} at ${snapshot.status}`,
        );
      }

      // A zero remainder means the deposit covered the total — nothing to
      // invoice; the transition to READY_TO_SHIP still stands.
      const [plan] = balancePlan(order.paymentSchedule, order.totalCents, this.#paidCents(payments), issuedAt);
      if (!plan) {
        return null;
      }

      const payment = await this.#schedulePayment(
        tx,
        order,
        "BALANCE",
        plan.amountCents,
        order.paymentSchedule === "NET_30" ? net30DueAt(shippedAt ?? issuedAt) : issuedAt,
      );
      await this.#issueInvoice(
        tx,
        order,
        subOrder.id,
        "COMMERCIAL",
        plan.amountCents,
        order.paymentSchedule === "NET_30" ? "Net-30 receivable" : "Balance due before shipment",
        issuedAt,
        payment.id,
      );
      await this.#audit(tx, ORDER_AUDIT.balanceIssued, "Order", orderId, `${plan.amountCents}c`);
      return payment;
    });
  }

  /** Supplier creates the shipment record (tracking to follow). */
  async createShipment(orderId: string, input: { carrier: string; trackingNumber?: string; subOrderId?: string }) {
    this.#require("shipment:manage");
    return this.#db.$transaction(async (tx) => {
      const { order, subOrder } = await this.#loadSupplierLeg(tx, orderId, input.subOrderId);
      const shipment = await tx.shipment.create({
        data: {
          subOrderId: subOrder.id,
          orgId: subOrder.orgId,
          carrier: input.carrier,
          trackingNumber: input.trackingNumber,
        },
      });
      await this.#audit(tx, ORDER_AUDIT.shipmentCreated, "Shipment", shipment.id, input.carrier);
      return { order, shipment };
    });
  }

  /**
   * Shipment leaves the dock: record transit, move the order SHIPPED (the
   * machine enforces the paid-balance gate on 30/70), and stamp shippedAt
   * for the 7-day auto-release clock.
   */
  async markShipmentInTransit(shipmentId: string, at: Date = new Date()) {
    this.#require("shipment:manage");
    return this.#db.$transaction(async (tx) => {
      const { shipment, subOrder } = await this.#loadShipment(tx, shipmentId);
      if (shipment.status === "IN_TRANSIT" || shipment.status === "DELIVERED") {
        return shipment; // idempotent replay
      }
      const order = await this.#loadForUpdate(tx, subOrder.orderId);
      const payments = await tx.payment.findMany({ where: { orderId: order.id, status: "SUCCEEDED" } });
      const disputes = await tx.dispute.findFirst({
        where: { orderId: order.id, status: { in: ["OPEN", "UNDER_REVIEW"] } },
      });
      const updated = await this.#transition(tx, order, payments, disputes?.id ?? null, { type: "SHIP", at });
      const marked = await tx.shipment.update({
        where: { id: shipmentId },
        data: { status: "IN_TRANSIT", shippedAt: at },
      });
      await tx.subOrder.update({ where: { id: subOrder.id }, data: { status: "SHIPPED" } });
      await this.#audit(tx, ORDER_AUDIT.shipmentInTransit, "Shipment", shipmentId);
      return { ...marked, orderStatus: updated.status };
    });
  }

  /**
   * Delivery confirmation — idempotent (double-confirm ⇒ single transfer,
   * spec acceptance). Evaluates escrow release immediately after delivery.
   */
  async confirmDelivery(shipmentId: string, at: Date = new Date()) {
    this.#require("shipment:manage");
    const result = await this.#db.$transaction(async (tx) => {
      const { shipment, subOrder } = await this.#loadShipment(tx, shipmentId);
      if (shipment.status === "DELIVERED") {
        return { delivered: false as const, orderId: subOrder.orderId };
      }
      const order = await this.#loadForUpdate(tx, subOrder.orderId);
      const payments = await tx.payment.findMany({ where: { orderId: order.id, status: "SUCCEEDED" } });
      const disputes = await tx.dispute.findFirst({
        where: { orderId: order.id, status: { in: ["OPEN", "UNDER_REVIEW"] } },
      });
      await this.#transition(tx, order, payments, disputes?.id ?? null, { type: "DELIVER", at });
      await tx.shipment.update({
        where: { id: shipmentId },
        data: { status: "DELIVERED", deliveredAt: at },
      });
      await tx.subOrder.update({ where: { id: subOrder.id }, data: { status: "DELIVERED" } });
      await this.#audit(tx, ORDER_AUDIT.shipmentDelivered, "Shipment", shipmentId);
      return { delivered: true as const, orderId: order.id };
    });
    // Release evaluation reads post-transaction state — run it outside the tx.
    const release = await this.releaseEscrow(result.orderId, at);
    return { ...result, release };
  }

  // ── escrow: release, sweep, disputes, payouts ─────────────────────────────

  /**
   * Idempotent escrow release (safe under replay): re-running after a
   * release finds a zero balance and exits; the release/commission/payout
   * rows are unique-keyed, so a crashed double-run cannot double-move.
   */
  async releaseEscrow(orderId: string, at: Date = new Date()) {
    this.#require("shipment:manage");
    return this.#db.$transaction(async (tx) => {
      const order = await this.#loadForUpdate(tx, orderId);
      const entries = await tx.escrowLedgerEntry.findMany({ where: { orderId } });
      const payments = await tx.payment.findMany({ where: { orderId, status: "SUCCEEDED" } });
      const openDispute = await tx.dispute.findFirst({
        where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
      });

      const shipment = await tx.shipment.findFirst({
        where: { subOrder: { orderId } },
        orderBy: { deliveredAt: "desc" },
      });
      const decision = releaseDecision(
        {
          status: order.status,
          deliveredAt: shipment?.deliveredAt ?? null,
          shippedAt: shipment?.shippedAt ?? null,
        },
        openDispute?.id ?? null,
        at,
      );
      if (decision.action === "HOLD_DISPUTE") {
        return { released: false as const, reason: "dispute-open" as const };
      }
      if (decision.action === "NOT_ELIGIBLE") {
        return { released: false as const, reason: "not-eligible" as const };
      }

      // Auto path: the 7-day window converts SHIPPED into DELIVERED first
      // (deterministic — the sweep passes `at`).
      let current = order;
      if (current.status === "SHIPPED") {
        current = await this.#transition(tx, current, payments, null, { type: "DELIVER", at });
      }
      if (current.status === "DELIVERED") {
        current = await this.#transition(tx, current, payments, null, { type: "RELEASE_ESCROW", at });
      }

      const held = escrowBalance(entries.map((entry) => ({ kind: entry.kind, amountCents: entry.amountCents })));
      if (held <= 0) {
        return { released: false as const, reason: "nothing-held" as const };
      }

      // Release + commission entries (unique keys make replays no-ops).
      const split = commissionSplit(held, order.commissionBps);
      await this.#escrowEntry(tx, current, {
        kind: "RELEASE",
        amountCents: split.netCents,
        idempotencyKey: escrowKeys.release(orderId),
        occurredAt: at,
      });
      await this.#escrowEntry(tx, current, {
        kind: "COMMISSION",
        amountCents: split.commissionCents,
        idempotencyKey: escrowKeys.commission(orderId),
        occurredAt: at,
      });
      await this.#audit(tx, ORDER_AUDIT.escrowRelease, "Order", orderId, `${held}c via ${decision.via}`);

      // Payout rows per supplier leg (idempotent per leg).
      const subOrders = await tx.subOrder.findMany({ where: { orderId } });
      for (const sub of subOrders) {
        const legSplit = commissionSplit(sub.totalCents, order.commissionBps);
        const existing = await tx.payout.findUnique({
          where: { idempotencyKey: escrowKeys.payout(orderId, sub.id) },
        });
        if (!existing) {
          const payout = await tx.payout.create({
            data: {
              orgId: sub.orgId,
              orderId,
              subOrderId: sub.id,
              amountCents: sub.totalCents,
              commissionCents: legSplit.commissionCents,
              netCents: legSplit.netCents,
              dueAt: at,
              idempotencyKey: escrowKeys.payout(orderId, sub.id),
            },
          });
          await this.#audit(tx, ORDER_AUDIT.payoutCreated, "Payout", payout.id, `${legSplit.netCents}c net`);
        }
      }
      return { released: true as const, via: decision.via, amountCents: held };
    });
  }

  /**
   * Deterministic background sweep (the Inngest job's mock twin): releases
   * every order whose 7-day auto window has elapsed. Delivery-confirmed
   * orders release on their own confirmDelivery call; this catches the
   * never-confirmed tail.
   */
  async sweepEscrowReleases(now: Date) {
    const candidates = await this.#db.order.findMany({
      where: { status: { in: ["SHIPPED", "DELIVERED"] } },
      include: { subOrders: true },
    });
    let released = 0;
    for (const order of candidates) {
      const entries = await this.#db.escrowLedgerEntry.findMany({ where: { orderId: order.id } });
      if (escrowBalance(entries.map((entry) => ({ kind: entry.kind, amountCents: entry.amountCents }))) <= 0) {
        continue;
      }
      const result = await this.releaseEscrow(order.id, now);
      if (result.released) {
        released += 1;
      }
    }
    return { released };
  }

  /** Net-30 off-session charge run (deterministic clock; replay-safe). */
  async runNet30Charges(now: Date) {
    const due = await this.#db.payment.findMany({
      where: {
        kind: "BALANCE",
        schedule: "NET_30",
        status: "PENDING",
        dueAt: { lte: now },
      },
      include: { order: true },
    });
    let charged = 0;
    let failed = 0;
    for (const payment of due) {
      try {
        await this.payScheduledPayment(payment.orderId, payment.id);
        charged += 1;
      } catch {
        // payScheduledPayment recorded FAILED + an audit entry; count the
        // receivable and keep working the rest of the run.
        failed += 1;
      }
    }
    return { charged, failed };
  }

  /** Staff mediation resolves a dispute: partial refund, then release remainder. */
  async resolveDispute(
    orderId: string,
    disputeId: string,
    resolution:
      | { type: "RELEASE" }
      | { type: "REFUND_FULL"; reason: string }
      | { type: "REFUND_PARTIAL"; amountCents: number; reason: string }
      | { type: "BACK_TO_DELIVERED" },
  ) {
    this.#require("dispute:mediate");
    const at = new Date();
    return this.#db.$transaction(async (tx) => {
      const order = await this.#loadForUpdate(tx, orderId);
      const dispute = await tx.dispute.findFirst({ where: { id: disputeId, orderId } });
      if (!dispute) {
        throw new RecordNotFoundError("Dispute", disputeId);
      }
      if (dispute.status !== "OPEN" && dispute.status !== "UNDER_REVIEW") {
        throw new OrderWorkflowError(`dispute ${disputeId} is already ${dispute.status}`);
      }
      const payments = await tx.payment.findMany({ where: { orderId, status: "SUCCEEDED" } });
      const entries = await tx.escrowLedgerEntry.findMany({ where: { orderId } });
      const held = escrowBalance(entries.map((entry) => ({ kind: entry.kind, amountCents: entry.amountCents })));

      let to: OrderSnapshot["status"];
      if (resolution.type === "RELEASE") {
        to = "ESCROW_RELEASED";
        const split = commissionSplit(held, order.commissionBps);
        await this.#escrowEntry(tx, order, {
          kind: "RELEASE",
          amountCents: split.netCents,
          idempotencyKey: escrowKeys.release(orderId),
          occurredAt: at,
        });
        await this.#escrowEntry(tx, order, {
          kind: "COMMISSION",
          amountCents: split.commissionCents,
          idempotencyKey: escrowKeys.commission(orderId),
          occurredAt: at,
        });
        await this.#createPayouts(tx, order, at);
      } else if (resolution.type === "REFUND_FULL") {
        to = "CANCELLED";
        for (const payment of payments) {
          await this.#refundPaymentRow(tx, order, payment.id, payment.amountCents, resolution.reason, at);
        }
      } else if (resolution.type === "REFUND_PARTIAL") {
        to = "PARTIALLY_REFUNDED";
        const paid = payments.reduce((sum, p) => sum + p.amountCents, 0);
        if (resolution.amountCents <= 0 || resolution.amountCents > paid) {
          throw new EscrowError(`partial refund ${resolution.amountCents}c exceeds captured ${paid}c`);
        }
        await this.#refundPaymentRow(tx, order, payments[0]?.id ?? null, resolution.amountCents, resolution.reason, at, disputeId);
      } else {
        to = "DELIVERED";
      }

      await this.#transition(tx, order, payments, disputeId, {
        type: "RESOLVE_DISPUTE",
        at,
        to,
      });
      const outcome =
        resolution.type === "RELEASE"
          ? "RELEASE_ESCROW"
          : resolution.type === "REFUND_FULL"
            ? "FULL_REFUND"
            : resolution.type === "REFUND_PARTIAL"
              ? "PARTIAL_REFUND"
              : "MIXED";
      await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: "RESOLVED",
          resolvedAt: at,
          outcome,
          ...(resolution.type === "REFUND_PARTIAL" ? { refundCents: resolution.amountCents } : {}),
          resolutionNote: "reason" in resolution ? resolution.reason : resolution.type,
        },
      });
      await this.#audit(tx, ORDER_AUDIT.disputeResolve, "Dispute", disputeId, to);
      return { disputeId, resolvedTo: to };
    });
  }

  /** Staff settles a payout with a mock transfer record (idempotent). */
  async settlePayout(payoutId: string, at: Date = new Date()) {
    this.#require("payout:settle");
    return this.#db.$transaction(async (tx) => {
      const payout = await tx.payout.findUnique({ where: { id: payoutId } });
      if (!payout) {
        throw new RecordNotFoundError("Payout", payoutId);
      }
      if (payout.status === "PAID") {
        return payout; // idempotent replay
      }
      const sub = payout.subOrderId
        ? await tx.subOrder.findUnique({ where: { id: payout.subOrderId } })
        : null;
      const supplierOrgId = sub?.orgId ?? payout.orgId;
      const profile = await tx.supplierProfile.findUnique({ where: { orgId: supplierOrgId } });
      const connectedAccountId = profile?.stripeConnectAccountId ?? `acct_mock_${supplierOrgId}`;
      const transfer = await this.#payments.transferToConnectedAccount({
        chargeId: `charge_mock_${payout.orderId}`,
        connectedAccountId,
        amountCents: payout.netCents,
      });
      const settled = await tx.payout.update({
        where: { id: payoutId },
        data: { status: "PAID", paidAt: at, stripeTransferId: transfer.id },
      });
      await this.#audit(tx, ORDER_AUDIT.payoutSettled, "Payout", payoutId, `${payout.netCents}c`);
      return settled;
    });
  }

  // ── read models ───────────────────────────────────────────────────────────

  /** Held / released / commissioned / refunded totals for an order. */
  async escrowSummary(orderId: string) {
    const order = await this.getOrder(orderId);
    const entries: { kind: EscrowEntryKind; amountCents: number }[] = order.escrowEntries.map((entry) => ({
      kind: entry.kind,
      amountCents: entry.amountCents,
    }));
    return {
      heldCents: escrowBalance(entries),
      releasedCents: order.escrowEntries
        .filter((entry) => entry.kind === "RELEASE")
        .reduce((sum, entry) => sum + entry.amountCents, 0),
      commissionCents: order.escrowEntries
        .filter((entry) => entry.kind === "COMMISSION")
        .reduce((sum, entry) => sum + entry.amountCents, 0),
      refundedCents: order.escrowEntries
        .filter((entry) => entry.kind === "REFUND" || entry.kind === "PARTIAL_REFUND")
        .reduce((sum, entry) => sum + entry.amountCents, 0),
    };
  }

  /** Download URL for an invoice's (mock) PDF through the storage port. */
  async getInvoicePdfUrl(orderId: string, invoiceId: string) {
    const order = await this.getOrder(orderId);
    const invoice = order.invoices.find((doc) => doc.id === invoiceId);
    if (!invoice?.pdfFileId) {
      throw new RecordNotFoundError("Invoice PDF", invoiceId);
    }
    return this.#storage.signedUrl(invoice.pdfFileId);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  #paidCents(payments: { kind: string; status: string; amountCents: number }[]): number {
    return payments
      .filter((p) => p.status === "SUCCEEDED")
      .reduce((sum, p) => sum + p.amountCents, 0);
  }

  /** Load an order inside a transaction, refusing cross-org writes. */
  async #loadForUpdate(tx: Prisma.TransactionClient, orderId: string): Promise<OrderRow> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { subOrders: true, orderLines: true },
    });
    if (!order) {
      throw new RecordNotFoundError("Order", orderId);
    }
    const isBuyer = order.orgId === this.#auth.orgId;
    const isSupplier = order.subOrders.some((sub) => sub.orgId === this.#auth.orgId);
    const isStaff = this.#auth.role === "AEKOVERA_STAFF";
    if (!isBuyer && !isSupplier && !isStaff) {
      throw new OrderWorkflowError(`organization ${this.#auth.orgId} may not access order ${orderId}`);
    }
    return order;
  }

  /** Supplier route: the acting org must own the fulfillment leg. */
  async #loadSupplierLeg(tx: Prisma.TransactionClient, orderId: string, subOrderId?: string) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { subOrders: true, orderLines: true },
    });
    if (!order) {
      throw new RecordNotFoundError("Order", orderId);
    }
    const subOrder = subOrderId
      ? order.subOrders.find((sub) => sub.id === subOrderId)
      : order.subOrders.find((sub) => sub.orgId === this.#auth.orgId) ?? order.subOrders[0];
    if (!subOrder || (subOrder.orgId !== this.#auth.orgId && this.#auth.role !== "AEKOVERA_STAFF")) {
      throw new OrderWorkflowError(`organization ${this.#auth.orgId} does not fulfill order ${orderId}`);
    }
    return { order, subOrder };
  }

  async #loadShipment(tx: Prisma.TransactionClient, shipmentId: string) {
    const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) {
      throw new RecordNotFoundError("Shipment", shipmentId);
    }
    const subOrder = await tx.subOrder.findUnique({ where: { id: shipment.subOrderId } });
    if (!subOrder) {
      throw new RecordNotFoundError("SubOrder", shipment.subOrderId);
    }
    if (subOrder.orgId !== this.#auth.orgId && this.#auth.role !== "AEKOVERA_STAFF") {
      throw new OrderWorkflowError(`organization ${this.#auth.orgId} does not own shipment ${shipmentId}`);
    }
    return { shipment, subOrder };
  }

  /** Schedule a payment row keyed off the order and milestone kind. */
  async #schedulePayment(
    tx: Prisma.TransactionClient,
    order: OrderRow,
    kind: "DEPOSIT" | "BALANCE" | "FULL",
    amountCents: number,
    dueAt: Date,
  ) {
    const idempotencyKey = escrowKeys.payment(order.id, kind);
    const existing = await tx.payment.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return existing;
    }
    const payment = await tx.payment.create({
      data: {
        orgId: order.orgId,
        orderId: order.id,
        schedule: order.paymentSchedule,
        kind,
        amountCents,
        dueAt,
        idempotencyKey,
      },
    });
    await this.#audit(tx, ORDER_AUDIT.paymentScheduled, "Payment", payment.id, `${kind} ${amountCents}c`);
    return payment;
  }

  /** Issue an invoice with a deterministic per-org number and mock PDF. */
  async #issueInvoice(
    tx: Prisma.TransactionClient,
    order: OrderRow,
    subOrderId: string | null,
    kind: "PRO_FORMA" | "COMMERCIAL" | "CREDIT_NOTE",
    totalCents: number,
    note: string,
    at: Date,
    paymentId?: string,
  ) {
    const existing = await tx.invoice.findFirst({
      where: { orderId: order.id, kind },
    });
    if (existing) {
      return existing;
    }
    const count = await tx.invoice.count({ where: { orgId: order.orgId } });
    const number = `INV-${String(count + 1).padStart(5, "0")}-${kind === "PRO_FORMA" ? "PF" : kind === "COMMERCIAL" ? "CO" : "CN"}`;
    const dueAt =
      kind === "PRO_FORMA" ? at : order.paymentSchedule === "NET_30" ? net30DueAt(at) : at;
    const pdfKey = `invoices/${order.id}/${number.toLowerCase()}.txt`;
    await this.#storage.put(
      pdfKey,
      `PackSource invoice ${number}\nOrder ${order.id}\nTotal ${totalCents} cents\n${note}\nIssued ${at.toISOString()}\n`,
      "text/plain",
    );
    const invoice = await tx.invoice.create({
      data: {
        orderId: order.id,
        subOrderId,
        orgId: order.orgId,
        supplierOrgId: order.subOrders[0]?.orgId ?? order.orderLines[0]?.orgId ?? "",
        kind,
        number,
        status: "ISSUED",
        issuedAt: at,
        dueAt,
        subtotalCents: totalCents,
        totalCents,
        pdfFileId: pdfKey,
        ...(paymentId ? { payments: { connect: { id: paymentId } } } : {}),
      },
    });
    if (paymentId) {
      await tx.payment.update({ where: { id: paymentId }, data: { invoiceId: invoice.id } });
    }
    await this.#audit(tx, ORDER_AUDIT.invoiceIssued, "Invoice", invoice.id, number);
    return invoice;
  }

  /** Append one escrow movement (unique idempotency key). */
  async #escrowEntry(
    tx: Prisma.TransactionClient,
    order: OrderRow,
    entry: {
      kind: "HOLD" | "RELEASE" | "COMMISSION" | "REFUND" | "PARTIAL_REFUND";
      amountCents: number;
      idempotencyKey: string;
      stripeRef?: string;
      paymentId?: string;
      occurredAt: Date;
    },
  ) {
    const existing = await tx.escrowLedgerEntry.findUnique({ where: { idempotencyKey: entry.idempotencyKey } });
    if (existing) {
      return existing; // replay — the movement already happened
    }
    const created = await tx.escrowLedgerEntry.create({
      data: {
        orgId: order.orgId,
        orderId: order.id,
        kind: entry.kind,
        amountCents: entry.amountCents,
        idempotencyKey: entry.idempotencyKey,
        ...(entry.stripeRef ? { stripeRef: entry.stripeRef } : {}),
        ...(entry.paymentId ? { note: `payment ${entry.paymentId}` } : {}),
        occurredAt: entry.occurredAt,
      },
    });
    return created;
  }

  /** Refund one payment: mock refund, Refund row, escrow mirror entry. */
  async #refundPaymentRow(
    tx: Prisma.TransactionClient,
    order: OrderRow,
    paymentId: string | null,
    amountCents: number,
    reason: string,
    at: Date,
    disputeId?: string,
  ) {
    if (!paymentId) {
      throw new EscrowError("cannot refund without a captured payment");
    }
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== "SUCCEEDED") {
      throw new OrderWorkflowError(`payment ${paymentId} is not refundable`);
    }
    const idempotencyKey = disputeId
      ? escrowKeys.partialRefund(order.id, disputeId)
      : escrowKeys.refund(order.id, paymentId);
    const existing = await tx.refund.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return existing; // replay
    }
    const mock = await this.#payments.refundCharge(`charge_mock_${order.id}`, amountCents);
    const refund = await tx.refund.create({
      data: {
        orgId: order.orgId,
        orderId: order.id,
        paymentId,
        amountCents,
        reason,
        status: "SUCCEEDED",
        stripeRefundId: mock.id,
        idempotencyKey,
      },
    });
    await this.#escrowEntry(tx, order, {
      kind: disputeId ? "PARTIAL_REFUND" : "REFUND",
      amountCents,
      idempotencyKey,
      stripeRef: mock.id,
      occurredAt: at,
    });
    await this.#audit(tx, ORDER_AUDIT.refundIssued, "Refund", refund.id, `${amountCents}c ${reason}`);
    return refund;
  }

  /** Create PENDING payout rows for every supplier leg (idempotent). */
  async #createPayouts(tx: Prisma.TransactionClient, order: OrderRow, at: Date) {
    const subOrders = await tx.subOrder.findMany({ where: { orderId: order.id } });
    for (const sub of subOrders) {
      const legSplit = commissionSplit(sub.totalCents, order.commissionBps);
      const existing = await tx.payout.findUnique({
        where: { idempotencyKey: escrowKeys.payout(order.id, sub.id) },
      });
      if (!existing) {
        await tx.payout.create({
          data: {
            orgId: sub.orgId,
            orderId: order.id,
            subOrderId: sub.id,
            amountCents: sub.totalCents,
            commissionCents: legSplit.commissionCents,
            netCents: legSplit.netCents,
            dueAt: at,
            idempotencyKey: escrowKeys.payout(order.id, sub.id),
          },
        });
      }
    }
  }
}
