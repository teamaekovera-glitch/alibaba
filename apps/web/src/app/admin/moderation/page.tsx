import Link from "next/link";
import { redirect } from "next/navigation";
import { staffContext } from "@/lib/admin/staff";
import { moderationQueue } from "@/lib/admin/moderation";
import { ModerationForm } from "../forms";

/**
 * Review moderation queue (spec: administration — PENDING reviews, staff
 * publish/reject with reasons). Queue reads gate on moderation:manage; the
 * layout gate has already excluded non-admins.
 */
export default async function ModerationPage() {
  const auth = await staffContext();
  if (!auth) {
    redirect("/sign-in");
  }
  const queue = await moderationQueue(auth);

  return (
    <section>
      <h2 className="text-lg font-semibold" data-testid="moderation-title">
        Review moderation
      </h2>
      <p className="mt-1 text-sm text-neutral-600">
        Purchaser reviews land here after submission. Publishing makes them
        public; rejecting records a reason and notifies the author.
      </p>

      {queue.length === 0 ? (
        <p className="mt-6 rounded-md border border-neutral-200 bg-white p-6 text-sm text-neutral-600" data-testid="moderation-empty">
          No reviews are awaiting moderation.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {queue.map((review) => (
            <li key={review.id} className="rounded-lg border border-neutral-200 bg-white p-5" data-testid="moderation-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium" data-testid="moderation-item-title">
                    {review.title || "Untitled review"}
                  </p>
                  <p className="text-xs text-neutral-500">
                    by {review.authorUser.email} · {review.org.name} · quality {review.qualityRating}/5
                  </p>
                </div>
                <Link className="text-xs underline" href={`/orders/${review.orderId}`}>
                  Order
                </Link>
              </div>
              {review.body ? <p className="mt-2 text-sm text-neutral-700">{review.body}</p> : null}
              <ModerationForm reviewId={review.id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
