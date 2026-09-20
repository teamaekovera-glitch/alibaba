/**
 * Escrow math and release rules (spec: "Escrow semantics on Stripe
 * Connect"). PackSource is the platform of record: charges capture to the
 * platform balance (the hold), transfers go to the supplier's connected
 * account only on delivery confirmation or the 7-day auto-release window,
 * and a dispute freezes transfers. Every movement writes an
 * EscrowLedgerEntry; this module owns the pure math and decisions the
 * repository applies inside its transactions.
 */
import type { EscrowEntryKind, OrderStatus } from "@packsource/db";

/** Auto-release window after shipment (spec: "the 7-day auto-release"). */
export const AUTO_RELEASE_WINDOW_DAYS = 7;

/** Raised when an escrow movement would corrupt the ledger. */
export class EscrowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowError";
  }
}

/**
 * Split gross into commission + supplier net: commission = round(gross ×
 * bps / 10_000), net = gross − commission. Net can never go negative, and
 * the two parts always sum back to gross exactly.
 */
export function commissionSplit(
  grossCents: number,
  commissionBps: number,
): { commissionCents: number; netCents: number } {
  if (!Number.isInteger(grossCents) || grossCents < 0) {
    throw new EscrowError(`gross must be a non-negative integer: ${grossCents}`);
  }
  if (!Number.isInteger(commissionBps) || commissionBps < 0) {
    throw new EscrowError(`commission bps must be a non-negative integer: ${commissionBps}`);
  }
  const commissionCents = Math.round((grossCents * commissionBps) / 10_000);
  return { commissionCents, netCents: grossCents - commissionCents };
}

/** Ledger directions: HOLD adds to the held balance, everything else draws it down. */
const LEDGER_INFLOW: readonly EscrowEntryKind[] = ["HOLD"];

/** Outflow kinds, drawn from the held balance. */
const LEDGER_OUTFLOW: readonly EscrowEntryKind[] = [
  "RELEASE",
  "COMMISSION",
  "REFUND",
  "PARTIAL_REFUND",
];

/**
 * Running held-funds balance for a set of ledger entries. Amounts are
 * stored positive; the entry kind carries the direction. Throws when the
 * entries would draw the balance below zero — that is ledger corruption,
 * never a state to paper over.
 */
export function escrowBalance(entries: { kind: EscrowEntryKind; amountCents: number }[]): number {
  let balance = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.amountCents) || entry.amountCents < 0) {
      throw new EscrowError(`ledger amount must be a non-negative integer: ${entry.amountCents}`);
    }
    if (LEDGER_INFLOW.includes(entry.kind)) {
      balance += entry.amountCents;
    } else if (LEDGER_OUTFLOW.includes(entry.kind)) {
      balance -= entry.amountCents;
    } else {
      throw new EscrowError(`unknown ledger kind: ${String(entry.kind)}`);
    }
    if (balance < 0) {
      throw new EscrowError(`escrow balance went negative (${balance}) — ledger corrupted`);
    }
  }
  return balance;
}

/** The decision a release job can act on. */
export type ReleaseDecision =
  | { action: "RELEASE"; via: "delivery" | "auto" }
  | { action: "HOLD_DISPUTE" }
  | { action: "NOT_ELIGIBLE" };

/**
 * Should escrow release for this order right now?
 * - DELIVERED + no open dispute → release (buyer click or carrier POD).
 * - SHIPPED past the 7-day auto-release window + no dispute → release.
 * - Open dispute → HOLD_DISPUTE (freeze — spec: "disputes freeze the
 *   transfer").
 * - Anything else → NOT_ELIGIBLE.
 * Deterministic: the clock is a parameter, never Date.now().
 */
export function releaseDecision(
  order: {
    status: OrderStatus;
    shippedAt: Date | null;
    deliveredAt: Date | null;
  },
  openDisputeId: string | null,
  now: Date,
): ReleaseDecision {
  if (openDisputeId) {
    return { action: "HOLD_DISPUTE" };
  }
  if (order.status === "DELIVERED") {
    return { action: "RELEASE", via: "delivery" };
  }
  if (order.status === "SHIPPED" && order.shippedAt) {
    const windowMs = AUTO_RELEASE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (now.getTime() - order.shippedAt.getTime() >= windowMs) {
      return { action: "RELEASE", via: "auto" };
    }
  }
  return { action: "NOT_ELIGIBLE" };
}

/**
 * Deterministic idempotency keys — the guard against Stripe webhook
 * replays and Inngest retries (spec: "idempotency keys on every money
 * event"). Same logical movement ⇒ same key ⇒ the unique constraint turns
 * a replay into a no-op.
 */
export const escrowKeys = {
  hold: (paymentId: string) => `hold:${paymentId}`,
  release: (orderId: string) => `release:${orderId}`,
  commission: (orderId: string) => `commission:${orderId}`,
  refund: (orderId: string, paymentId: string) => `refund:${orderId}:${paymentId}`,
  partialRefund: (orderId: string, disputeId: string) => `refund:${orderId}:partial:${disputeId}`,
  payout: (orderId: string, subOrderId: string) => `payout:${orderId}:${subOrderId}`,
  payment: (orderId: string, kind: string) => `pay:${orderId}:${kind}`,
  invoice: (orderId: string, seq: number) => `invoice:${orderId}:${seq}`,
} as const;
