/**
 * Dispute lifecycle state machine (spec: "Disputes" — buyer opens with
 * reason/evidence, supplier responds, staff resolves per the outcome set).
 * Pure and deterministic; the disputes repository persists only what this
 * machine accepts.
 *
 *   OPEN ──START_REVIEW──▶ UNDER_REVIEW ──RESOLVE──▶ RESOLVED
 *     │  │                      │
 *     │  └─RESPOND/ATTACH_EVIDENCE (self-loops)
 *     └─WITHDRAW▶ WITHDRAWN
 *
 * RESOLVED and WITHDRAWN are terminal. The order-status side of a
 * resolution (refund/escrow transitions) stays in the order machine —
 * this machine governs the dispute row only.
 */
import type { DisputeStatus } from "@packsource/db";

/** Events accepted by the dispute machine. */
export type DisputeEvent =
  | { type: "START_REVIEW"; at: Date }
  | { type: "RESPOND"; at: Date }
  | { type: "ATTACH_EVIDENCE"; at: Date }
  | { type: "WITHDRAW"; at: Date }
  | { type: "RESOLVE"; at: Date };

export type DisputeEventType = DisputeEvent["type"];

export interface DisputeSnapshot {
  status: DisputeStatus;
}

export interface DisputeTransition {
  from: DisputeStatus;
  to: DisputeStatus;
  at: Date;
}

const RESPONSE_ACCEPTING: readonly DisputeStatus[] = ["OPEN", "UNDER_REVIEW"];
const OPEN_STATUSES: readonly DisputeStatus[] = ["OPEN", "UNDER_REVIEW"];

function toPlan(snapshot: DisputeSnapshot, to: DisputeStatus, at: Date): DisputeTransition[] {
  return snapshot.status === to ? [] : [{ from: snapshot.status, to, at }];
}

/** All legal (status, event) pairs — append-only discussion events are self-loops. */
export function disputeTransition(dispute: DisputeSnapshot, event: DisputeEvent): DisputeTransition[] {
  switch (event.type) {
    case "RESPOND":
    case "ATTACH_EVIDENCE":
      if (!RESPONSE_ACCEPTING.includes(dispute.status)) {
        return [];
      }
      return [{ from: dispute.status, to: dispute.status, at: event.at }];
    case "START_REVIEW":
      if (dispute.status !== "OPEN") {
        return [];
      }
      return [{ from: "OPEN", to: "UNDER_REVIEW", at: event.at }];
    case "WITHDRAW":
      if (!OPEN_STATUSES.includes(dispute.status)) {
        return [];
      }
      return toPlan(dispute, "WITHDRAWN", event.at);
    case "RESOLVE":
      if (!OPEN_STATUSES.includes(dispute.status)) {
        return [];
      }
      return toPlan(dispute, "RESOLVED", event.at);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function isLegalDisputeTransition(dispute: DisputeSnapshot, event: DisputeEvent): boolean {
  return disputeTransition(dispute, event).length > 0;
}

/** Statuses where escrow release stays frozen (mirrors the escrow contract). */
export const ESCROW_BLOCKING_DISPUTE_STATUSES: readonly DisputeStatus[] = ["OPEN", "UNDER_REVIEW"];

export function isEscrowBlocking(status: DisputeStatus): boolean {
  return ESCROW_BLOCKING_DISPUTE_STATUSES.includes(status);
}
