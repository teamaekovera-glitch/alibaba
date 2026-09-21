/**
 * Verified-purchase reviews (spec: "Reviews"). A buyer org may review only
 * listings on its own DELIVERED-or-later orders — eligibility is checked
 * against the actual order row through the shared post-delivery status list
 * (order-machine), so review eligibility and escrow semantics can never
 * drift. One review per order-line. Fresh reviews land in moderation
 * (PENDING); staff publish or reject; supplier responses are one-shot.
 * Public read paths expose PUBLISHED reviews only, with authorship shown at
 * org level (spec contact rules: no personal emails or phones).
 */
import { Prisma, type PrismaClient } from "@packsource/db";
import { isDeliveredOrderStatus } from "../orders/order-machine";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";
import { redactContactInfo } from "../trade/redaction";
import { isLegalReviewModeration, validateRatings, type RatingAggregate, type RatingRow, averageRatings } from "./review-machine";
import { enforceRateLimit, findDuplicateReview } from "./fraud";

/** Audit-log actions written by the reviews repository. */
export const REVIEWS_AUDIT = {
  create: "review.create",
  moderate: "review.moderate",
  supplierResponse: "review.supplier_response",
} as const;

/** Business-rule violation inside the reviews domain (rendered as form copy). */
export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

/**
 * Internal signal raised inside the review transaction when a duplicate body
 * matches. The FraudFlag is written by the caller AFTER the rollback — a flag
 * written inside the aborted transaction would be rolled back along with it.
 */
class DuplicateReviewSignal extends Error {
  constructor(
    readonly prior: { id: string; listingId: string | null },
  ) {
    super("duplicate review body");
  }
}

export interface CreateReviewInput {
  orderId: string;
  /** The exact order line being reviewed — anchors the verified purchase. */
  orderLineId?: string;
  /** Optional target listing; must match the order line's listing. */
  listingId?: string;
  qualityRating: number;
  communicationRating: number;
  onTimeRating: number;
  packagingAccuracyRating: number;
  title?: string;
  body?: string;
  photos?: Array<{ fileId: string; alt?: string | null }>;
}

/** Published review as rendered on product/supplier pages. */
export interface PublicReview {
  id: string;
  listingId: string | null;
  reviewerOrgId: string;
  reviewerOrgName: string;
  qualityRating: number;
  communicationRating: number;
  onTimeRating: number;
  packagingAccuracyRating: number;
  title: string | null;
  body: string | null;
  supplierResponse: string | null;
  supplierRespondedAt: Date | null;
  createdAt: Date;
}

export class ReviewsRepository {
  readonly #db: PrismaClient;
  readonly #auth: AuthContext;

  constructor(db: PrismaClient, auth: AuthContext) {
    this.#db = db;
    this.#auth = auth;
  }

  #require(permission: Permission): void {
    assertCan(this.#auth.role, permission);
  }

  async #audit(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId: this.#auth.orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType,
        entityId,
        ...(after !== undefined ? { after } : {}),
      },
    });
  }

  /**
   * Submit a verified-purchase review (spec: "a buyer org may review only
   * listings from its own DELIVERED orders"). The review lands PENDING —
   * staff moderation decides visibility.
   */
  async createReview(input: CreateReviewInput) {
    this.#require("order:create");

    const invalid = validateRatings(input);
    if (invalid.length > 0) {
      throw new ReviewError(`ratings must be whole numbers 1–5 (offending: ${invalid.join(", ")})`);
    }

    // The order must belong to the acting org — a cross-org order reads as
    // not-found so tenancy never leaks through error messages.
    const order = await this.#db.order.findUnique({
      where: { id: input.orderId },
      include: { orderLines: true, subOrders: { select: { orgId: true } } },
    });
    if (!order || order.orgId !== this.#auth.orgId) {
      throw new RecordNotFoundError("Order", input.orderId);
    }
    if (!isDeliveredOrderStatus(order.status)) {
      throw new ReviewError(`order ${order.id} is not delivered (status ${order.status}) — reviews are verified-purchase only`);
    }

    // Anchor the review to an order line (one review per order-line).
    const line = input.orderLineId
      ? order.orderLines.find((candidate) => candidate.id === input.orderLineId)
      : undefined;
    if (input.orderLineId && !line) {
      throw new ReviewError(`order line ${input.orderLineId} is not part of order ${order.id}`);
    }
    const listingId = input.listingId ?? line?.listingId ?? null;
    if (line?.listingId && listingId !== line.listingId) {
      throw new ReviewError(`listing ${input.listingId} does not match the ordered line`);
    }
    const supplierOrgId = line?.orgId ?? order.subOrders[0]?.orgId ?? null;
    if (!supplierOrgId) {
      throw new ReviewError(`order ${order.id} has no supplier leg to review`);
    }
    if (supplierOrgId === this.#auth.orgId) {
      throw new ReviewError("cannot review your own organization");
    }

    // One review per order-line (spec). Supplier-level reviews (no line) are
    // capped at one per order.
    const duplicate = await this.#db.review.findFirst({
      where: {
        orderId: order.id,
        ...(input.orderLineId ? { orderLineId: input.orderLineId } : { orderLineId: null }),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ReviewError(
        input.orderLineId
          ? "this order line has already been reviewed"
          : "this order already has a supplier-level review",
      );
    }

    try {
      return await this.#db.$transaction(async (tx) => {
      // Fraud controls: sliding-window cap per buyer org, then a
      // duplicate-body check that flags repeat-paste reviews.
      await enforceRateLimit(tx, "reviews", this.#auth.orgId);
      if (input.body) {
        // Fingerprint the REDACTED body: stored bodies are redacted on write,
        // so comparing raw input against them would never match once an email
        // or phone is present.
        const prior = await findDuplicateReview(tx, this.#auth.orgId, redactContactInfo(input.body));
        if (prior) {
          // Escalate past the transaction boundary — see DuplicateReviewSignal.
          throw new DuplicateReviewSignal(prior);
        }
      }
      const review = await tx.review.create({
        data: {
          orgId: this.#auth.orgId,
          supplierOrgId,
          authorUserId: this.#auth.userId,
          listingId,
          orderId: order.id,
          orderLineId: input.orderLineId ?? null,
          qualityRating: input.qualityRating,
          communicationRating: input.communicationRating,
          onTimeRating: input.onTimeRating,
          packagingAccuracyRating: input.packagingAccuracyRating,
          title: input.title ?? null,
          // Same write-side hygiene as messaging: no contact details persist.
          body: input.body ? redactContactInfo(input.body) : null,
          photos: {
            create: (input.photos ?? []).map((photo) => ({
              orgId: this.#auth.orgId,
              fileId: photo.fileId,
              alt: photo.alt ?? null,
            })),
          },
        },
      });
      await this.#audit(tx, REVIEWS_AUDIT.create, "Review", review.id, { orderId: order.id });
      return review;
      });
    } catch (error) {
      if (!(error instanceof DuplicateReviewSignal)) {
        throw error;
      }
      await this.#db.fraudFlag.create({
        data: {
          orgId: this.#auth.orgId,
          subjectType: "listing",
          subjectId: error.prior.listingId ?? order.id,
          reason: `duplicate review body matching prior review ${error.prior.id}`,
          severity: "MEDIUM",
        },
      });
      throw new ReviewError("this review duplicates one you recently submitted");
    }
  }

  /** The reviewed supplier answers once (spec: one supplier response). */
  async respondToReview(reviewId: string, body: string) {
    this.#require("profile:manage");
    if (!body.trim()) {
      throw new ReviewError("write a response first");
    }
    return this.#db.$transaction(async (tx) => {
      const review = await tx.review.findUnique({ where: { id: reviewId } });
      if (!review || review.supplierOrgId !== this.#auth.orgId) {
        throw new RecordNotFoundError("Review", reviewId);
      }
      if (review.supplierResponse !== null) {
        throw new ReviewError("this review already has a supplier response");
      }
      const updated = await tx.review.update({
        where: { id: review.id },
        data: { supplierResponse: redactContactInfo(body), supplierRespondedAt: new Date() },
      });
      await this.#audit(tx, REVIEWS_AUDIT.supplierResponse, "Review", review.id);
      return updated;
    });
  }

  /** Staff moderation: publish or reject a PENDING review. */
  async moderate(
    reviewId: string,
    decision: "PUBLISH" | "REJECT",
    options: { reason?: string; at?: Date } = {},
  ) {
    this.#require("moderation:manage");
    const at = options.at ?? new Date();
    return this.#db.$transaction(async (tx) => {
      const review = await tx.review.findUnique({ where: { id: reviewId } });
      if (!review) {
        throw new RecordNotFoundError("Review", reviewId);
      }
      const event =
        decision === "PUBLISH"
          ? ({ type: "PUBLISH", at } as const)
          : ({ type: "REJECT", at, reason: options.reason ?? "moderation" } as const);
      const legal = isLegalReviewModeration(review, event);
      if (!legal) {
        throw new ReviewError(`review ${reviewId} is already ${review.moderationStatus}`);
      }
      const updated = await tx.review.update({
        where: { id: review.id },
        data: {
          moderationStatus: decision === "PUBLISH" ? "PUBLISHED" : "REJECTED",
          moderatedAt: at,
          moderatedByUserId: this.#auth.userId,
          rejectionReason: decision === "REJECT" ? options.reason ?? "moderation" : null,
        },
      });
      // Audit in the moderation-queue shape the admin console consumes:
      // before/after moderation status, one row per decision.
      await tx.auditLog.create({
        data: {
          orgId: this.#auth.orgId,
          actorUserId: this.#auth.userId,
          actorType: "user",
          action: REVIEWS_AUDIT.moderate,
          entityType: "Review",
          entityId: review.id,
          before: { moderationStatus: review.moderationStatus } as Prisma.InputJsonValue,
          after: {
            moderationStatus: updated.moderationStatus,
            reason: updated.rejectionReason,
          } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  /** Staff moderation queue: pending reviews, oldest first. */
  async moderationQueue() {
    this.#require("moderation:manage");
    return this.#db.review.findMany({
      where: { moderationStatus: "PENDING" },
      orderBy: { createdAt: "asc" },
      include: {
        org: { select: { id: true, name: true } },
        listing: { select: { id: true, title: true, slug: true } },
      },
    });
  }

  /** PUBLISHED reviews for a listing, newest first (public surface). */
  async listingReviews(listingId: string): Promise<PublicReview[]> {
    const rows = await this.#db.review.findMany({
      where: { listingId, moderationStatus: "PUBLISHED" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { org: { select: { id: true, name: true } } },
    });
    return rows.map((row) => this.#toPublic(row));
  }

  /** PUBLISHED reviews for a supplier org, newest first (public surface). */
  async supplierReviews(supplierOrgId: string): Promise<PublicReview[]> {
    const rows = await this.#db.review.findMany({
      where: { supplierOrgId, moderationStatus: "PUBLISHED" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { org: { select: { id: true, name: true } } },
    });
    return rows.map((row) => this.#toPublic(row));
  }

  /** Aggregate over a listing's published reviews. */
  async listingAggregate(listingId: string): Promise<RatingAggregate> {
    const rows: RatingRow[] = await this.#db.review.findMany({
      where: { listingId, moderationStatus: "PUBLISHED" },
      select: { qualityRating: true, communicationRating: true, onTimeRating: true, packagingAccuracyRating: true },
    });
    return averageRatings(rows);
  }

  /** Aggregate over a supplier's published reviews. */
  async supplierAggregate(supplierOrgId: string): Promise<RatingAggregate> {
    const rows: RatingRow[] = await this.#db.review.findMany({
      where: { supplierOrgId, moderationStatus: "PUBLISHED" },
      select: { qualityRating: true, communicationRating: true, onTimeRating: true, packagingAccuracyRating: true },
    });
    return averageRatings(rows);
  }

  #toPublic(row: Prisma.ReviewGetPayload<{ include: { org: { select: { id: true; name: true } } } }>): PublicReview {
    return {
      id: row.id,
      listingId: row.listingId,
      reviewerOrgId: row.org.id,
      // Org-level authorship only — no personal emails or phones.
      reviewerOrgName: row.org.name,
      qualityRating: row.qualityRating,
      communicationRating: row.communicationRating,
      onTimeRating: row.onTimeRating,
      packagingAccuracyRating: row.packagingAccuracyRating,
      title: row.title,
      // Read-side redaction: nothing leaks through pre-policy rows.
      body: row.body === null ? null : redactContactInfo(row.body),
      supplierResponse: row.supplierResponse === null ? null : redactContactInfo(row.supplierResponse),
      supplierRespondedAt: row.supplierRespondedAt,
      createdAt: row.createdAt,
    };
  }
}
