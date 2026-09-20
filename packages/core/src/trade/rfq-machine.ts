/**
 * RFQ lifecycle state machine — a pure function over (status, event) →
 * next status, per the spec's pattern for money-adjacent state ("the state
 * machine lives in packages/core as a pure function … unit-tested
 * exhaustively"). Illegal transitions throw; time-based guards are separate
 * pure predicates so the transition table stays exhaustive and testable.
 *
 * Schema enum: RfqStatus (DRAFT OPEN AWARDED CLOSED CANCELLED).
 */
import type { RfqMode, RfqStatus } from "@packsource/db";

export type RfqEvent =
  | { type: "SEND"; at: Date }
  | { type: "CLOSE"; at: Date }
  | { type: "AWARD"; at: Date }
  | { type: "CANCEL"; at: Date };

/** Raised when a transition is not in the legal table. */
export class IllegalRfqTransitionError extends Error {
  constructor(
    readonly status: RfqStatus,
    readonly event: RfqEvent["type"],
  ) {
    super(`illegal RFQ transition: ${event} from ${status}`);
    this.name = "IllegalRfqTransitionError";
  }
}

/**
 * The legal transition table. CLOSE keeps CLOSED non-terminal for auctions:
 * after the close time the buyer picks a winner (CLOSED → AWARDED). For
 * non-auction RFQs, CLOSE is an early manual close and an award from CLOSED
 * remains possible for the same reason — the buyer chose to stop accepting
 * quotes and may still pick one.
 */
const LEGAL_TRANSITIONS: Record<RfqStatus, Partial<Record<RfqEvent["type"], RfqStatus>>> = {
  DRAFT: { SEND: "OPEN", CANCEL: "CANCELLED" },
  OPEN: { CLOSE: "CLOSED", AWARD: "AWARDED", CANCEL: "CANCELLED" },
  CLOSED: { AWARD: "AWARDED" },
  AWARDED: {},
  CANCELLED: {},
};

/**
 * Apply an event to an RFQ's status. Throws IllegalRfqTransitionError when
 * the transition is not legal — callers persist nothing before this returns.
 */
export function rfqTransition(status: RfqStatus, event: RfqEvent): RfqStatus {
  const next = LEGAL_TRANSITIONS[status][event.type];
  if (!next) {
    throw new IllegalRfqTransitionError(status, event.type);
  }
  return next;
}

/** Snapshot the guards need: mode + optional auction close time. */
export interface RfqTimingGuards {
  mode: RfqMode;
  closesAt: Date | null;
}

/**
 * Auction close-time enforcement (spec: "reverse-auction … with a close
 * time"): an auction RFQ cannot award, close, or cancel before the close
 * time — bids compete until the window ends. Non-auction RFQs have no
 * close-time guard.
 */
export function assertCloseTimeAllows(
  guards: RfqTimingGuards,
  event: "AWARD" | "CLOSE" | "CANCEL",
  at: Date,
): void {
  if (guards.mode !== "AUCTION" || !guards.closesAt) {
    return;
  }
  if (at < guards.closesAt) {
    const error = new IllegalRfqTransitionError("OPEN", event);
    error.message = `${event} before auction close time ${guards.closesAt.toISOString()} is not allowed — bids compete until the window ends`;
    throw error;
  }
}

/**
 * Quote-expiry predicate used at award time: a quote whose validity window
 * has passed cannot be accepted (spec: "rejects expired quotes at accept").
 */
export function isQuoteValidAt(
  quote: { validFrom: Date; validUntil: Date },
  at: Date,
): boolean {
  return quote.validFrom <= at && at <= quote.validUntil;
}

/** RFQ deadline passed? An OPEN RFQ with a past need-by/close time is closeable. */
export function isRfqPastDue(rfq: { mode: RfqMode; closesAt: Date | null }, at: Date): boolean {
  return rfq.mode === "AUCTION" && rfq.closesAt !== null && at >= rfq.closesAt;
}
