/**
 * The listing state machine and its publish gate (spec: Supplier console →
 * Listing management, Moderation & fraud → listing review).
 *
 * States are the schema's `ListingStatus` enum values — DRAFT, PENDING_REVIEW,
 * LIVE, PAUSED, REJECTED. The lifecycle the spec describes ("DRAFT →
 * PENDING_REVIEW → published, plus reject/unpublish paths") maps onto them:
 *
 *   DRAFT ──submit──▶ PENDING_REVIEW ──publish──▶ LIVE ◀──republish── PAUSED
 *      ▲                   │      │                  │                  │
 *      │◀────revise───── REJECTED  │                  └────unpublish────▶┘
 *      │◀────withdraw──────┘      (PENDING_REVIEW can also go back to DRAFT)
 *
 * Publish-only-after-submit is structural: no transition enters LIVE except
 * from PENDING_REVIEW (and the PAUSED republish, which only exists because
 * the listing was approved once already). Every edge names the permission
 * that may traverse it; repositories call `assertListingTransition` before
 * any status write and audit with the paired action name.
 */
import type { ListingStatus, SpecExtractionStatus } from "@packsource/db";
import type { Permission } from "./permissions";

/** Named edges of the listing lifecycle. */
export type ListingTransitionAction =
  | "submit" // DRAFT → PENDING_REVIEW (supplier hands the listing to review)
  | "publish" // PENDING_REVIEW → LIVE (platform moderation approves)
  | "reject" // PENDING_REVIEW → REJECTED (platform moderation declines)
  | "withdraw" // PENDING_REVIEW → DRAFT (supplier pulls it back to edit)
  | "unpublish" // LIVE → PAUSED (supplier takes a live listing off the market)
  | "republish" // PAUSED → LIVE (already approved once — no re-review needed)
  | "resumeEditing" // PAUSED → DRAFT (edit a paused listing)
  | "revise"; // REJECTED → DRAFT (address moderation feedback)

export interface ListingTransition {
  action: ListingTransitionAction;
  from: ListingStatus;
  to: ListingStatus;
  permission: Permission;
}

/**
 * The complete legal edge list. Anything not listed here is illegal —
 * notably DRAFT → LIVE (publish-only-after-submit) and every edge out of
 * REJECTED except back to DRAFT.
 */
export const LISTING_TRANSITIONS: readonly ListingTransition[] = [
  { action: "submit", from: "DRAFT", to: "PENDING_REVIEW", permission: "listing:manage" },
  { action: "publish", from: "PENDING_REVIEW", to: "LIVE", permission: "moderation:manage" },
  { action: "reject", from: "PENDING_REVIEW", to: "REJECTED", permission: "moderation:manage" },
  { action: "withdraw", from: "PENDING_REVIEW", to: "DRAFT", permission: "listing:manage" },
  { action: "unpublish", from: "LIVE", to: "PAUSED", permission: "listing:manage" },
  { action: "republish", from: "PAUSED", to: "LIVE", permission: "listing:manage" },
  { action: "resumeEditing", from: "PAUSED", to: "DRAFT", permission: "listing:manage" },
  { action: "revise", from: "REJECTED", to: "DRAFT", permission: "listing:manage" },
];

/** Raised when a status change is not an edge of the lifecycle. */
export class IllegalListingTransitionError extends Error {
  constructor(
    readonly from: ListingStatus,
    readonly to: ListingStatus,
  ) {
    super(`illegal listing transition: ${from} → ${to}`);
    this.name = "IllegalListingTransitionError";
  }
}

/** The legal edge for from → to, or null when that transition is illegal. */
export function listingTransition(from: ListingStatus, to: ListingStatus): ListingTransition | null {
  return LISTING_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

/** Throwing flavor — the gate every status write calls first. */
export function assertListingTransition(from: ListingStatus, to: ListingStatus): ListingTransition {
  const transition = listingTransition(from, to);
  if (!transition) {
    throw new IllegalListingTransitionError(from, to);
  }
  return transition;
}

/** Actions available from a status — drives both UI and authorization. */
export function availableListingActions(status: ListingStatus): ListingTransitionAction[] {
  return LISTING_TRANSITIONS.filter((t) => t.from === status).map((t) => t.action);
}

/** Audit-log action names for transitions (append-only AuditLog table). */
export const LISTING_TRANSITION_AUDIT_ACTIONS: Record<ListingTransitionAction, string> = {
  submit: "listing.submit",
  publish: "listing.publish",
  reject: "listing.reject",
  withdraw: "listing.withdraw",
  unpublish: "listing.unpublish",
  republish: "listing.republish",
  resumeEditing: "listing.resume_editing",
  revise: "listing.revise",
};

// ── Spec-extraction confirmation gate ────────────────────────────────────────

/**
 * Raised when publishing would put a listing live while one of its spec
 * sheets still holds unreviewed extraction suggestions (spec: "spec-PDF
 * extraction writes draft fields but never publishes without supplier
 * confirmation" and the failure-mode table's "human confirmation gate
 * before publish").
 */
export class SpecExtractionUnconfirmedError extends Error {
  constructor(readonly specSheetIds: string[]) {
    super(
      `publish blocked — ${specSheetIds.length} spec sheet(s) have extraction suggestions ` +
        "that were never confirmed by a human",
    );
    this.name = "SpecExtractionUnconfirmedError";
  }
}

/**
 * The publish gate. A spec sheet blocks publication exactly when its
 * extraction produced suggestions that no human has confirmed (EXTRACTED).
 * UPLOADED sheets have produced nothing to review, FAILED sheets produced no
 * suggestions, and CONFIRMED sheets were reviewed — none of those can
 * silently put unreviewed AI output in front of buyers.
 */
export function assertPublishAllowed(
  specSheets: readonly { id: string; extractionStatus: SpecExtractionStatus }[],
): void {
  const unconfirmed = specSheets
    .filter((sheet) => sheet.extractionStatus === "EXTRACTED")
    .map((sheet) => sheet.id);
  if (unconfirmed.length > 0) {
    throw new SpecExtractionUnconfirmedError(unconfirmed);
  }
}
