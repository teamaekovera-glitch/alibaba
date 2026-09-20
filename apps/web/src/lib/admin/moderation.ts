/**
 * Review moderation queue (spec: administration — review moderation PENDING →
 * PUBLISHED/REJECTED, every decision audited). The transition rule is a pure
 * function; the action writes the review update + audit row + author
 * notification (in-app + mock email) inside one transaction. The notification
 * engine is injected so tests and callers share one deterministic outbox.
 */
import { Prisma, type PrismaClient } from "@packsource/db";
import { RecordNotFoundError, assertCan, type AuthContext } from "@packsource/core";
import type { NotificationEngine } from "@packsource/notifications";
import { db } from "@/lib/db";

export const MODERATION_AUDIT = {
  decide: "review.moderate",
} as const;

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

  return database.$transaction(async (tx) => {
    const review = await tx.review.findUnique({
      where: { id: input.reviewId },
    });
    if (!review) {
      throw new RecordNotFoundError("Review", input.reviewId);
    }
    reviewModerationTransition(review.moderationStatus, input.decision);

    await tx.review.update({
      where: { id: review.id },
      data: {
        moderationStatus: input.decision,
        moderatedAt: input.now,
        moderatedByUserId: auth.userId,
        rejectionReason: input.decision === "REJECTED" ? (input.reason?.trim() ?? null) : null,
      },
    });

    // Append-only audit trail — one row per decision.
    await tx.auditLog.create({
      data: {
        orgId: review.orgId,
        actorUserId: auth.userId,
        actorType: "user",
        action: MODERATION_AUDIT.decide,
        entityType: "Review",
        entityId: review.id,
        before: { moderationStatus: review.moderationStatus } as Prisma.InputJsonValue,
        after: {
          moderationStatus: input.decision,
          reason: input.decision === "REJECTED" ? (input.reason?.trim() ?? null) : null,
        } as Prisma.InputJsonValue,
      },
    });

    // The author learns the outcome in-app and by (mock) email.
    const sent = await notifications.notify({
      orgId: review.orgId,
      userIds: [review.authorUserId],
      kind: "REVIEW_MODERATION_DECIDED",
      title:
        input.decision === "PUBLISHED" ? "Your review was published" : "Your review was rejected",
      body:
        input.decision === "REJECTED"
          ? (input.reason?.trim() ?? "A moderator rejected this review.")
          : "Thanks — your review is now live on the listing.",
      linkUrl: review.orderId ? `/orders/${review.orderId}` : "/notifications",
      entityType: "Review",
      entityId: review.id,
      now: input.now,
    });
    return {
      reviewId: review.id,
      moderationStatus: input.decision,
      notificationIds: sent.notificationIds,
      emailIds: sent.emails.map((email) => email.emailId),
    };
  });
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
