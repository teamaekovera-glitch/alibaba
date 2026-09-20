/**
 * Quote lifecycle state machine — pure transition table (same pattern as
 * rfq-machine). Schema enum: QuoteStatus (DRAFT SUBMITTED ACCEPTED DECLINED
 * EXPIRED WITHDRAWN SUPERSEDED). Time-based rules (validity window, RFQ
 * must be open) are separate pure predicates so the table stays exhaustive.
 */
import type { QuoteStatus } from "@packsource/db";

export type QuoteEvent =
  | { type: "SUBMIT"; at: Date }
  | { type: "ACCEPT"; at: Date }
  | { type: "DECLINE"; at: Date }
  | { type: "EXPIRE"; at: Date }
  | { type: "WITHDRAW"; at: Date }
  | { type: "SUPERSEDE"; at: Date };

/** Raised when a transition is not in the legal table. */
export class IllegalQuoteTransitionError extends Error {
  constructor(
    readonly status: QuoteStatus,
    readonly event: QuoteEvent["type"],
  ) {
    super(`illegal quote transition: ${event} from ${status}`);
    this.name = "IllegalQuoteTransitionError";
  }
}

/** Terminal quote states — no events apply. */
export const TERMINAL_QUOTE_STATUSES: readonly QuoteStatus[] = [
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
  "WITHDRAWN",
  "SUPERSEDED",
];

const LEGAL_QUOTE_TRANSITIONS: Record<QuoteStatus, Partial<Record<QuoteEvent["type"], QuoteStatus>>> = {
  DRAFT: { SUBMIT: "SUBMITTED", WITHDRAW: "WITHDRAWN" },
  SUBMITTED: {
    ACCEPT: "ACCEPTED",
    DECLINE: "DECLINED",
    EXPIRE: "EXPIRED",
    WITHDRAW: "WITHDRAWN",
    SUPERSEDE: "SUPERSEDED",
  },
  ACCEPTED: {},
  DECLINED: {},
  EXPIRED: {},
  WITHDRAWN: {},
  SUPERSEDED: {},
};

/**
 * Apply an event to a quote's status. Throws IllegalQuoteTransitionError
 * when the transition is not legal.
 */
export function quoteTransition(status: QuoteStatus, event: QuoteEvent): QuoteStatus {
  const next = LEGAL_QUOTE_TRANSITIONS[status][event.type];
  if (!next) {
    throw new IllegalQuoteTransitionError(status, event.type);
  }
  return next;
}
