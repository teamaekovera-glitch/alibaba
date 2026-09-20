/**
 * Review moderation pipeline (spec: "Reviews" — verified-purchase reviews
 * land in moderation; staff publish or reject; only PUBLISHED reviews are
 * public). Pure and deterministic.
 */
import type { ReviewModerationStatus } from "@packsource/db";

export type ReviewModerationEvent =
  | { type: "PUBLISH"; at: Date }
  | { type: "REJECT"; at: Date; reason: string };

export interface ReviewModerationSnapshot {
  moderationStatus: ReviewModerationStatus;
}

export interface ReviewModerationTransition {
  from: ReviewModerationStatus;
  to: ReviewModerationStatus;
  at: Date;
}

/** PENDING is the only mutable state; terminal states accept nothing. */
export function reviewModerationTransition(
  review: ReviewModerationSnapshot,
  event: ReviewModerationEvent,
): ReviewModerationTransition[] {
  if (review.moderationStatus !== "PENDING") {
    return [];
  }
  return [{ from: "PENDING", to: event.type === "PUBLISH" ? "PUBLISHED" : "REJECTED", at: event.at }];
}

export function isLegalReviewModeration(
  review: ReviewModerationSnapshot,
  event: ReviewModerationEvent,
): boolean {
  return reviewModerationTransition(review, event).length > 0;
}

/** Rating axes on a review (spec: quality, communication, on-time, packaging accuracy). */
export const RATING_AXES = [
  "qualityRating",
  "communicationRating",
  "onTimeRating",
  "packagingAccuracyRating",
] as const;

export type RatingAxis = (typeof RATING_AXES)[number];

export interface RatingInput {
  qualityRating: number;
  communicationRating: number;
  onTimeRating: number;
  packagingAccuracyRating: number;
}

/** Every axis is an integer 1..5 — reject anything else at the boundary. */
export function validateRatings(ratings: RatingInput): RatingAxis[] {
  return RATING_AXES.filter((axis) => {
    const value = ratings[axis];
    return !Number.isInteger(value) || value < 1 || value > 5;
  });
}

export interface RatingRow {
  qualityRating: number;
  communicationRating: number;
  onTimeRating: number;
  packagingAccuracyRating: number;
}

export interface RatingAggregate {
  count: number;
  average: number | null;
  axes: Record<RatingAxis, number | null>;
}

/** Aggregate published-review ratings — one-decimal precision, mean of the four axes. */
export function averageRatings(rows: RatingRow[]): RatingAggregate {
  if (rows.length === 0) {
    return {
      count: 0,
      average: null,
      axes: {
        qualityRating: null,
        communicationRating: null,
        onTimeRating: null,
        packagingAccuracyRating: null,
      },
    };
  }
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const axes = Object.fromEntries(
    RATING_AXES.map((axis) => [
      axis,
      Math.round((sum(rows.map((row) => row[axis])) / rows.length) * 10) / 10,
    ]),
  ) as Record<RatingAxis, number | null>;
  const overall = RATING_AXES.reduce((total, axis) => total + (axes[axis] ?? 0), 0) / RATING_AXES.length;
  return { count: rows.length, average: Math.round(overall * 10) / 10, axes };
}
