/**
 * Fraud controls (spec: "Trust & comms" — rate limits on review and message
 * creation, duplicate-review detection, admin actions audited).
 *
 * Verification-tier floors: the spec mandates tiers for contact sharing only
 * (messaging + RFQ negotiation own that policy — see trust/contact-policy and
 * trade/redaction). Reviews verify against actual delivered orders, which is
 * strictly stronger than a tier floor; disputes are gated by order
 * participation. So no additional tier floors exist here by design.
 *
 * The rate limiter is a sliding window over the RateLimitEvent stream
 * (PR #3's model, indexed on scope+identifier+createdAt): each accepted
 * action inserts one event, and enforcement counts events inside the
 * window. Repositories call it inside their transaction so rejected or
 * rolled-back actions never count.
 */
import type { PrismaClient, Prisma } from "@packsource/db";
import { createHash } from "node:crypto";

export type FraudRateLimitScope = "reviews" | "messages";

export interface RateLimitPolicy {
  /** Accepted actions per sliding window per identifier. */
  limit: number;
  windowMs: number;
  /** Human-readable copy for the error surface. */
  windowLabel: string;
}

/**
 * Policy: reviews are scarce (verified purchases, one per order-line);
 * messages are conversational but burst-capped. These are product config —
 * tests seed events to exercise the boundary, not the specific numbers.
 */
export const FRAUD_RATE_LIMITS: Record<FraudRateLimitScope, RateLimitPolicy> = {
  reviews: { limit: 5, windowMs: 24 * 60 * 60 * 1000, windowLabel: "24 hours" },
  messages: { limit: 60, windowMs: 60 * 60 * 1000, windowLabel: "an hour" },
};

/** Thrown when an org exceeds a fraud rate limit (rendered as form copy). */
export class FraudRateLimitError extends Error {
  readonly scope: FraudRateLimitScope;
  readonly policy: RateLimitPolicy;

  constructor(scope: FraudRateLimitScope, policy: RateLimitPolicy) {
    super(`rate limit exceeded: at most ${policy.limit} ${scope} per ${policy.windowLabel}`);
    this.name = "FraudRateLimitError";
    this.scope = scope;
    this.policy = policy;
  }
}

/**
 * Count an accepted action against the sliding window, throwing
 * FraudRateLimitError when the org is over budget. Call inside the same
 * transaction as the action so counting stays atomic with acceptance.
 * `now` is injectable for deterministic tests.
 */
export async function enforceRateLimit(
  db: PrismaClient | Prisma.TransactionClient,
  scope: FraudRateLimitScope,
  identifier: string,
  options: { now?: Date } = {},
): Promise<void> {
  const policy = FRAUD_RATE_LIMITS[scope];
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - policy.windowMs);
  const accepted = await db.rateLimitEvent.count({
    where: { scope, identifier, createdAt: { gte: windowStart, lte: now } },
  });
  if (accepted >= policy.limit) {
    throw new FraudRateLimitError(scope, policy);
  }
  await db.rateLimitEvent.create({
    data: { scope, identifier, createdAt: now },
  });
}

/**
 * Duplicate-review detection: the same buyer org re-submitting materially
 * identical review bodies across orders/listings. Normalization collapses
 * whitespace and case so trivial edits do not evade the check.
 */
export function normalizeReviewBody(body: string): string {
  return body.trim().toLowerCase().replace(/\s+/g, " ");
}

export function reviewBodyFingerprint(body: string): string {
  return createHash("sha256").update(normalizeReviewBody(body)).digest("hex");
}

/** How far back duplicate detection looks. */
export const DUPLICATE_REVIEW_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Returns the matching prior review when the acting org already submitted a
 * review with the same body fingerprint inside the lookback window.
 * `now` is injectable for deterministic tests.
 */
export async function findDuplicateReview(
  db: PrismaClient | Prisma.TransactionClient,
  orgId: string,
  body: string,
  options: { now?: Date } = {},
): Promise<{ id: string; listingId: string | null } | null> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - DUPLICATE_REVIEW_LOOKBACK_MS);
  const recent = await db.review.findMany({
    where: { orgId, createdAt: { gte: cutoff } },
    select: { id: true, listingId: true, body: true },
  });
  const fingerprint = reviewBodyFingerprint(body);
  const match = recent.find((row) => row.body !== null && reviewBodyFingerprint(row.body) === fingerprint);
  return match ? { id: match.id, listingId: match.listingId } : null;
}
