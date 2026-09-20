/**
 * Order lifecycle state machine — pure transition function (spec: "Order
 * and escrow lifecycle"). The schema enum OrderStatus is the state space;
 * this module owns which (status, event) pairs move an order and which are
 * illegal. Every repository mutation runs through here first — adapter calls
 * (Stripe mock, storage) happen only after a transition is accepted.
 *
 * Schedule shapes (spec: payment schedules FULL_PREPAY | DEPOSIT_30_70 |
 * NET_30):
 * - FULL_PREPAY:  DRAFT → DEPOSIT_DUE → DEPOSIT_PAID → IN_PRODUCTION →
 *   READY_TO_SHIP → SHIPPED → DELIVERED → ESCROW_RELEASED → CLOSED. The
 *   "deposit" is 100% of the order, so no BALANCE_DUE leg exists.
 * - DEPOSIT_30_70: same until READY_TO_SHIP, then the balance is invoiced
 *   before shipment → BALANCE_DUE; the balance must be paid before SHIP.
 * - NET_30 (staff-approved buyers only): the deposit legs are skipped —
 *   PLACE goes straight to IN_PRODUCTION and the balance is invoiced on
 *   shipment, charged off-session on the due date. The receivable lives on
 *   the Invoice (dueAt), not the order status, so SHIPPED stays truthful.
 *
 * Disputes: OPEN_DISPUTE is legal from the first paid state through
 * DELIVERED and moves the order to DISPUTED; escrow release is refused
 * while a dispute is open (the repository passes openDisputeId in the
 * snapshot, keeping the freeze rule pure and exhaustively testable).
 */
import type { OrderStatus, PaymentSchedule } from "@packsource/db";

/** Events driving the order state machine. */
export type OrderEvent =
  | { type: "PLACE"; at: Date }
  | { type: "PAY_DEPOSIT"; at: Date }
  | { type: "START_PRODUCTION"; at: Date }
  | { type: "COMPLETE_PRODUCTION"; at: Date }
  | { type: "ISSUE_BALANCE"; at: Date }
  | { type: "SHIP"; at: Date }
  | { type: "DELIVER"; at: Date }
  | { type: "RELEASE_ESCROW"; at: Date }
  | { type: "CLOSE"; at: Date }
  | { type: "CANCEL"; at: Date }
  | { type: "OPEN_DISPUTE"; at: Date }
  | { type: "RESOLVE_DISPUTE"; at: Date; to: OrderStatus };

export type OrderEventType = OrderEvent["type"];

/** The slice of order state the machine reads. Pure input — no DB handles. */
export interface OrderSnapshot {
  status: OrderStatus;
  paymentSchedule: PaymentSchedule;
  /** Balance payment succeeded (DEPOSIT_30_70 ships only after this). */
  balancePaid: boolean;
  /** Open dispute id, if any — a dispute freezes escrow release. */
  openDisputeId?: string | null;
}

/** One accepted status move: from --event--> to at a point in time. */
export interface OrderTransition {
  from: OrderStatus;
  to: OrderStatus;
  event: OrderEventType;
  at: Date;
}

/** Raised when a transition is not in the legal table. */
export class IllegalOrderTransitionError extends Error {
  constructor(
    readonly status: OrderStatus,
    readonly event: OrderEventType,
    readonly schedule: PaymentSchedule,
  ) {
    super(`illegal order transition: ${event} from ${status} (${schedule})`);
    this.name = "IllegalOrderTransitionError";
  }
}

/** Terminal order states — no events apply. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  "CLOSED",
  "CANCELLED",
];

/** Dispute resolutions may land the order in these states only. */
export const LEGAL_DISPUTE_RESOLUTIONS: readonly OrderStatus[] = [
  "SHIPPED",
  "DELIVERED",
  "ESCROW_RELEASED",
  "PARTIALLY_REFUNDED",
  "CANCELLED",
];

/**
 * States at or after delivery — the shared definition of "delivered" for
 * verified-purchase reviews, delivered-order counters, and contact-sharing.
 * Kept next to the state machine so review eligibility and escrow semantics
 * can never drift apart.
 */
export const POST_DELIVERY_ORDER_STATUSES: readonly OrderStatus[] = [
  "DELIVERED",
  "ESCROW_RELEASED",
  "PARTIALLY_REFUNDED",
  "CLOSED",
];

export function isDeliveredOrderStatus(status: OrderStatus): boolean {
  return POST_DELIVERY_ORDER_STATUSES.includes(status);
}

/** Cancel is legal until production starts (spec: "Cancel before production"). */
const CANCELABLE_STATUSES: readonly OrderStatus[] = [
  "DRAFT",
  "DEPOSIT_DUE",
  "DEPOSIT_PAID",
];

/** Open-dispute is legal once money is held and until escrow releases. */
const DISPUTABLE_STATUSES: readonly OrderStatus[] = [
  "DEPOSIT_PAID",
  "IN_PRODUCTION",
  "READY_TO_SHIP",
  "BALANCE_DUE",
  "SHIPPED",
  "DELIVERED",
];

/**
 * Resolve the target status for (snapshot, event), or null when the event
 * is illegal from this status + schedule. Exhaustive over OrderStatus.
 */
function targetFor(order: OrderSnapshot, event: OrderEvent): OrderStatus | null {
  if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
    return null;
  }
  switch (order.status) {
    case "DRAFT":
      if (event.type === "CANCEL") return "CANCELLED";
      if (event.type === "PLACE") {
        // NET_30 skips the deposit legs entirely (balance invoices on shipment).
        return order.paymentSchedule === "NET_30" ? "IN_PRODUCTION" : "DEPOSIT_DUE";
      }
      return null;
    case "DEPOSIT_DUE":
      if (event.type === "PAY_DEPOSIT") return "DEPOSIT_PAID";
      if (event.type === "CANCEL") return "CANCELLED";
      return null;
    case "DEPOSIT_PAID":
      if (event.type === "START_PRODUCTION") return "IN_PRODUCTION";
      if (event.type === "CANCEL") return "CANCELLED";
      if (event.type === "OPEN_DISPUTE") return "DISPUTED";
      return null;
    case "IN_PRODUCTION":
      if (event.type === "COMPLETE_PRODUCTION") return "READY_TO_SHIP";
      if (event.type === "OPEN_DISPUTE") return "DISPUTED";
      return null;
    case "READY_TO_SHIP":
      if (event.type === "ISSUE_BALANCE") {
        // Only the 30/70 schedule carries a balance leg before shipment.
        return order.paymentSchedule === "DEPOSIT_30_70" ? "BALANCE_DUE" : null;
      }
      if (event.type === "SHIP") {
        // 30/70 must pass through BALANCE_DUE (balance invoiced, then paid).
        return order.paymentSchedule === "DEPOSIT_30_70" ? null : "SHIPPED";
      }
      if (event.type === "OPEN_DISPUTE") return "DISPUTED";
      return null;
    case "BALANCE_DUE":
      if (event.type === "SHIP") return order.balancePaid ? "SHIPPED" : null;
      if (event.type === "OPEN_DISPUTE") return "DISPUTED";
      return null;
    case "SHIPPED":
      if (event.type === "DELIVER") return "DELIVERED";
      if (event.type === "OPEN_DISPUTE") return "DISPUTED";
      return null;
    case "DELIVERED":
      if (event.type === "RELEASE_ESCROW") {
        return order.openDisputeId ? null : "ESCROW_RELEASED";
      }
      if (event.type === "OPEN_DISPUTE") return "DISPUTED";
      return null;
    case "DISPUTED":
      if (event.type === "RESOLVE_DISPUTE" && LEGAL_DISPUTE_RESOLUTIONS.includes(event.to)) {
        return event.to;
      }
      return null;
    case "PARTIALLY_REFUNDED":
      // Dispute resolved to a partial refund — the escrow remainder releases.
      if (event.type === "RELEASE_ESCROW") {
        return order.openDisputeId ? null : "ESCROW_RELEASED";
      }
      return null;
    case "ESCROW_RELEASED":
      if (event.type === "CLOSE") return "CLOSED";
      return null;
    case "CLOSED":
    case "CANCELLED":
      return null;
  }
}

/**
 * Apply an event to an order snapshot. Throws IllegalOrderTransitionError
 * when the move is not legal. Returns the (single-step) transition plan —
 * an array per the spec's `(order, event) → transitions[]` shape.
 */
export function orderTransition(order: OrderSnapshot, event: OrderEvent): OrderTransition[] {
  const to = targetFor(order, event);
  if (to === null) {
    throw new IllegalOrderTransitionError(order.status, event.type, order.paymentSchedule);
  }
  return [{ from: order.status, to, event: event.type, at: event.at }];
}

/** Is this event legal for the snapshot? (Pure — repositories guard with it.) */
export function isLegalOrderTransition(order: OrderSnapshot, event: OrderEvent): boolean {
  return targetFor(order, event) !== null;
}

/** Statuses an order may move to from its current state (exhaustive sweep). */
export function legalOrderTargets(order: OrderSnapshot): OrderStatus[] {
  const events: OrderEvent[] = [
    { type: "PLACE", at: new Date(0) },
    { type: "PAY_DEPOSIT", at: new Date(0) },
    { type: "START_PRODUCTION", at: new Date(0) },
    { type: "COMPLETE_PRODUCTION", at: new Date(0) },
    { type: "ISSUE_BALANCE", at: new Date(0) },
    { type: "SHIP", at: new Date(0) },
    { type: "DELIVER", at: new Date(0) },
    { type: "RELEASE_ESCROW", at: new Date(0) },
    { type: "CLOSE", at: new Date(0) },
    { type: "CANCEL", at: new Date(0) },
    { type: "OPEN_DISPUTE", at: new Date(0) },
    { type: "RESOLVE_DISPUTE", at: new Date(0), to: "ESCROW_RELEASED" },
  ];
  const targets = new Set<OrderStatus>();
  for (const event of events) {
    const to = targetFor(order, event);
    if (to !== null) {
      targets.add(to);
    }
  }
  return [...targets];
}

/** States where a buyer can still cancel before production. */
export function isCancelable(status: OrderStatus): boolean {
  return CANCELABLE_STATUSES.includes(status);
}

/** States where a dispute may be opened (money held, escrow not released). */
export function isDisputable(status: OrderStatus): boolean {
  return DISPUTABLE_STATUSES.includes(status);
}
