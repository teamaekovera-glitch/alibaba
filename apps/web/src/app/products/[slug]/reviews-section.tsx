import {
  isDeliveredOrderStatus,
  listingRatingAggregate,
  publishedListingReviews,
} from "@packsource/core";
import { db } from "@/lib/db";

import { RespondToReviewForm, ReviewForm } from "./reviews-form";

type EligibleLine = { orderId: string; orderLineId: string; description: string };

export type ReviewsSectionData = {
  reviews: Awaited<ReturnType<typeof publishedListingReviews>>;
  aggregate: Awaited<ReturnType<typeof listingRatingAggregate>>;
  eligibleLines: EligibleLine[];
  isSupplier: boolean;
  isSignedIn: boolean;
};

/**
 * Data loader for the storefront reviews section. The page calls this in its
 * own async body so the rendered tree stays synchronous — legacy SSR
 * (renderToStaticMarkup) cannot resolve nested async server components, and
 * next-auth is imported lazily so anonymous storefront rendering stays
 * loadable in vitest SSR tests (next-auth v5 beta cannot resolve
 * `next/server` there).
 */
export async function loadReviewsSectionData(listingId: string, supplierOrgId: string): Promise<ReviewsSectionData> {
  const [reviews, aggregate] = await Promise.all([
    publishedListingReviews(db, listingId),
    listingRatingAggregate(db, listingId),
  ]);

  const { auth } = await import("@/auth");
  const session = await auth();
  const isSupplier = session?.user.orgId === supplierOrgId;

  let eligibleLines: EligibleLine[] = [];
  if (session?.user.orgId && !isSupplier) {
    const buyerOrgId = session.user.orgId;
    const [orders, reviewedLineIds] = await Promise.all([
      db.order.findMany({
        where: { orgId: buyerOrgId, orderLines: { some: { listingId } } },
        select: { id: true, status: true, orderLines: { where: { listingId }, select: { id: true, description: true } } },
      }),
      // One review per order line — hide lines the buyer has already reviewed.
      db.review.findMany({ where: { orgId: buyerOrgId, listingId }, select: { orderLineId: true } }),
    ]);
    const reviewed = new Set(reviewedLineIds.map((row) => row.orderLineId));
    eligibleLines = orders
      .filter((order) => isDeliveredOrderStatus(order.status))
      .flatMap((order) =>
        order.orderLines
          .filter((line) => !reviewed.has(line.id))
          .map((line) => ({ orderId: order.id, orderLineId: line.id, description: line.description })),
      );
  }

  return { reviews, aggregate, eligibleLines, isSupplier, isSignedIn: Boolean(session?.user.orgId) };
}

/**
 * Storefront reviews section (spec: "Trust & comms — reviews"): verified-
 * purchase aggregate, published reviews with org-level authorship, supplier
 * responses, and — for buyers with an unreviewed delivered order line — the
 * write-review form. Core enforces every rule again on submit; the eligibility
 * query in loadReviewsSectionData only decides whether the form renders.
 */
export function ReviewsSection({ slug, reviews, aggregate, eligibleLines, isSupplier, isSignedIn }: ReviewsSectionData & { slug: string }) {
  const axes: Array<[label: string, value: number | null]> = [
    ["Quality", aggregate.axes.qualityRating],
    ["Communication", aggregate.axes.communicationRating],
    ["On time", aggregate.axes.onTimeRating],
    ["Packaging", aggregate.axes.packagingAccuracyRating],
  ];

  return (
    <section className="mt-10" data-testid="reviews-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-neutral-900">Reviews</h2>
        {aggregate.count > 0 ? (
          <p className="text-sm text-neutral-600" data-testid="reviews-aggregate">
            <span className="font-medium text-neutral-900">{aggregate.average?.toFixed(1)}</span> ★ ·{" "}
            {aggregate.count} verified {aggregate.count === 1 ? "review" : "reviews"}
          </p>
        ) : null}
      </div>

      {aggregate.count > 0 ? (
        <div className="mt-3 grid max-w-lg grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-600" data-testid="reviews-axes">
          {axes.map(([label, value]) => (
            <p key={label}>
              {label}: <span className="font-medium text-neutral-900">{value === null ? "—" : value.toFixed(1)}</span>
            </p>
          ))}
        </div>
      ) : null}

      {eligibleLines.length > 0 ? (
        <div className="mt-4">
          <ReviewForm
            slug={slug}
            orderId={eligibleLines[0]!.orderId}
            orderLineId={eligibleLines[0]!.orderLineId}
            lineDescription={eligibleLines[0]!.description}
          />
          {eligibleLines.length > 1 ? (
            <p className="mt-1 text-xs text-neutral-500">{eligibleLines.length - 1} more delivered line(s) you can review after this one.</p>
          ) : null}
        </div>
      ) : isSignedIn && !isSupplier ? (
        <p className="mt-4 text-xs text-neutral-500" data-testid="reviews-ineligible">
          Reviews are verified-purchase only — leave one after a delivered order for this listing.
        </p>
      ) : null}

      <div className="mt-5 space-y-4">
        {reviews.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="reviews-empty">
            No published reviews yet.
          </p>
        ) : (
          reviews.map((review) => (
            <article key={review.id} className="rounded-lg border border-neutral-200 p-4" data-testid="review-card">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-neutral-900" data-testid="review-author">
                  {review.reviewerOrgName}
                  <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
                    Verified purchase
                  </span>
                </p>
                <p className="text-xs text-neutral-500">{review.createdAt.getUTCFullYear()}</p>
              </div>
              <p className="mt-1 text-sm" data-testid="review-stars">
                ★ {review.qualityRating} · ☎ {review.communicationRating} · ⏱ {review.onTimeRating} · 📦{" "}
                {review.packagingAccuracyRating}
              </p>
              {review.title ? <p className="mt-2 text-sm font-medium text-neutral-900">{review.title}</p> : null}
              {review.body ? <p className="mt-1 text-sm text-neutral-700">{review.body}</p> : null}
              {review.supplierResponse ? (
                <div className="mt-3 rounded-md border-l-2 border-neutral-300 bg-neutral-50 px-3 py-2" data-testid="supplier-response">
                  <p className="text-xs font-medium text-neutral-600">Response from the supplier</p>
                  <p className="mt-1 text-sm text-neutral-700">{review.supplierResponse}</p>
                </div>
              ) : isSupplier ? (
                <RespondToReviewForm slug={slug} reviewId={review.id} />
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
