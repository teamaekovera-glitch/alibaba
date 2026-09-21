/**
 * Review moderation queue (spec: administration — review moderation PENDING →
 * PUBLISHED/REJECTED, every decision audited). The state machine, review
 * update, and audit row live in the core `ReviewsRepository`; this layer
 * keeps the pure transition check, adds the author notification (in-app +
 * mock email), and shares one deterministic outbox via the injected engine.
 */
import { type PrismaClient } from "@packsource/db";
import { RecordNotFoundError, ReviewsRepository, assertCan, type AuthContext } from "@packsource/core";
import type { NotificationEngine } from "@packsource/notifications";
import { db } from "@/lib/db";

export type ModerationDecision = "PUBLISHED" | "REJECTED";
/** Decided reviews are final — only the queue's PENDING rows are actionable. */
export class ReviewModerationStateError extends Error {
  constructor(reviewId: string, current: string) {
    super(`review ${reviewId} is not pending moderation (current state: ${current})`);
    this.name = "ReviewModerationStateError";
  }
}

/**
 * Pure transition check (PENDING → PUBLISHED | REJECTED; decided is final).
 * Unit-testable without a database.
 */
export function reviewModerationTransition(
  current: string,
  decision: ModerationDecision,
): ModerationDecision {
  if (current !== "PENDING") {
    throw new ReviewModerationStateError("", current);
  }
  return decision;
}

export interface ModerateReviewInput {
  reviewId: string;
  decision: ModerationDecision;
  /** Required for rejections — the reason surfaces to the author. */
  reason?: string;
  now: Date;
}

export interface ModerateReviewResult {
  reviewId: string;
  moderationStatus: ModerationDecision;
  notificationIds: string[];
  emailIds: string[];
}

/**
 * Apply a moderation decision to a review. Gates on `moderation:manage`
 * (the staff-only moderation permission); throws PermissionDeniedError for
 * every non-staff caller.
 */
export async function moderateReview(
  database: PrismaClient,
  auth: AuthContext,
  notifications: NotificationEngine,
  input: ModerateReviewInput,
): Promise<ModerateReviewResult> {
  assertCan(auth.role, "moderation:manage");
  if (input.decision === "REJECTED" && !input.reason?.trim()) {
    throw new Error("moderation rejection requires a reason");
  }

  const existing = await database.review.findUnique({
    where: { id: input.reviewId },
  });
  if (!existing) {
    throw new RecordNotFoundError("Review", input.reviewId);
  }
  // State-error contract: decided reviews are final (throws
  // ReviewModerationStateError before the repository's own machine check).
  reviewModerationTransition(existing.moderationStatus, input.decision);

  // Single domain transition — the core repository owns the state machine,
  // the review update, and the before/after audit row; this layer adds the
  // author notification so the engine stays the only notification path.
  const reviews = new ReviewsRepository(database, auth);
  await reviews.moderate(
    input.reviewId,
    input.decision === "PUBLISHED" ? "PUBLISH" : "REJECT",
    { reason: input.reason?.trim(), at: input.now },
  );

  // The author learns the outcome in-app and by (mock) email.
  const sent = await notifications.notify({
    orgId: existing.orgId,
    userIds: [existing.authorUserId],
    kind: "REVIEW_MODERATION_DECIDED",
    title:
      input.decision === "PUBLISHED" ? "Your review was published" : "Your review was rejected",
    body:
      input.decision === "REJECTED"
        ? (input.reason?.trim() ?? "A moderator rejected this review.")
        : "Thanks — your review is now live on the listing.",
    linkUrl: existing.orderId ? `/orders/${existing.orderId}` : "/notifications",
    entityType: "Review",
    entityId: existing.id,
    now: input.now,
  });
  return {
    reviewId: existing.id,
    moderationStatus: input.decision,
    notificationIds: sent.notificationIds,
    emailIds: sent.emails.map((email) => email.emailId),
  };
}

/**
 * The moderation queue: every PENDING review, oldest first (deterministic
 * FIFO for staff). Staff-only read.
 */
export async function moderationQueue(auth: AuthContext) {
  assertCan(auth.role, "moderation:manage");
  return db.review.findMany({
    where: { moderationStatus: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      authorUser: { select: { id: true, email: true } },
      org: { select: { id: true, name: true } },
    },
  });
}
