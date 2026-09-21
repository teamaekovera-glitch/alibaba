"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";
import { respondToReviewAction, writeReviewAction } from "./actions";

const inputClass = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-xs font-medium text-neutral-600";

function Feedback({ state }: { state: ActionState }) {
  if (!state) {
    return null;
  }
  if ("error" in state) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="review-form-error">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" data-testid="review-form-ok">
        {state.message}
      </p>
    );
  }
  return null;
}

const AXES = [
  { field: "quality", label: "Quality" },
  { field: "communication", label: "Communication" },
  { field: "onTime", label: "On time" },
  { field: "packaging", label: "Packaging accuracy" },
] as const;

function StarSelect({ label, field }: { label: string; field: string }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <select name={field} defaultValue="" required className={inputClass} data-testid={`review-${field}`}>
        <option value="" disabled>
          Choose…
        </option>
        {[1, 2, 3, 4, 5].map((star) => (
          <option key={star} value={star}>
            {"★".repeat(star)}
            {"☆".repeat(5 - star)} ({star})
          </option>
        ))}
      </select>
    </label>
  );
}

/** Verified-buyer write-review form; core enforces eligibility and fraud rules. */
export function ReviewForm({
  slug,
  orderId,
  orderLineId,
  lineDescription,
}: {
  slug: string;
  orderId: string;
  orderLineId: string;
  lineDescription: string;
}) {
  const [state, action, pending] = useActionState(writeReviewAction, null);
  return (
    <form action={action} className="mt-3 space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3" data-testid="write-review">
      <Feedback state={state} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="orderLineId" value={orderLineId} />
      <p className="text-xs text-neutral-500">
        Reviewing your order line <span className="font-medium text-neutral-700">{lineDescription}</span> — published after
        moderation.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {AXES.map((axis) => (
          <StarSelect key={axis.field} label={axis.label} field={axis.field} />
        ))}
      </div>
      <label className="block">
        <span className={labelClass}>Headline (optional)</span>
        <input name="title" className={inputClass} placeholder="Sums it up in a line" data-testid="review-title" />
      </label>
      <label className="block">
        <span className={labelClass}>Your review (optional)</span>
        <textarea name="body" rows={3} className={inputClass} placeholder="How did the run go?" data-testid="review-body" />
      </label>
      <button
        type="submit"
        disabled={pending}
        data-testid="review-submit"
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Working…" : "Submit review"}
      </button>
    </form>
  );
}

/** Supplier response form shown under their own listing's reviews. */
export function RespondToReviewForm({ slug, reviewId }: { slug: string; reviewId: string }) {
  const [state, action, pending] = useActionState(respondToReviewAction, null);
  return (
    <form action={action} className="mt-2 space-y-2" data-testid="respond-to-review">
      <Feedback state={state} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="reviewId" value={reviewId} />
      <textarea
        name="body"
        rows={2}
        required
        className={inputClass}
        placeholder="Respond publicly as the supplier…"
        data-testid="supplier-response-body"
      />
      <button
        type="submit"
        disabled={pending}
        data-testid="supplier-response-submit"
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Working…" : "Respond"}
      </button>
    </form>
  );
}
