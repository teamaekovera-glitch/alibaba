"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";
import { attachEvidenceAction, respondToDisputeAction, startDisputeReviewAction, withdrawDisputeAction } from "./trust-actions";

const inputClass = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";

function Feedback({ state }: { state: ActionState }) {
  if (!state) {
    return null;
  }
  if ("error" in state) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="dispute-form-error">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" data-testid="dispute-form-ok">
        {state.message}
      </p>
    );
  }
  return null;
}

function Submit({ pending, testid, label, tone = "dark" }: { pending: boolean; testid: string; label: string; tone?: "dark" | "quiet" }) {
  const toneClass = tone === "dark" ? "bg-neutral-900 text-white" : "border border-neutral-300 bg-white text-neutral-800";
  return (
    <button type="submit" disabled={pending} data-testid={testid} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${toneClass}`}>
      {pending ? "Working…" : label}
    </button>
  );
}

/** Participant discussion while a dispute is open or under review. */
export function DisputeRespondForm({ orderId, disputeId }: { orderId: string; disputeId: string }) {
  const [state, action, pending] = useActionState(respondToDisputeAction, null);
  return (
    <form action={action} className="mt-2 space-y-2" data-testid="dispute-respond">
      <Feedback state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="disputeId" value={disputeId} />
      <textarea name="body" rows={2} required className={inputClass} placeholder="Add to the discussion…" data-testid="dispute-response-body" />
      <Submit pending={pending} testid="dispute-respond-submit" label="Post response" />
    </form>
  );
}

/** Buyer/staff evidence attachment (file references from the storage mock). */
export function DisputeEvidenceForm({ orderId, disputeId }: { orderId: string; disputeId: string }) {
  const [state, action, pending] = useActionState(attachEvidenceAction, null);
  return (
    <form action={action} className="mt-2 space-y-2" data-testid="dispute-evidence">
      <Feedback state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="disputeId" value={disputeId} />
      <input name="fileId" required className={inputClass} placeholder="Evidence file reference (e.g. file_photo_01)" data-testid="dispute-evidence-file" />
      <input name="note" className={inputClass} placeholder="What does it show? (optional)" data-testid="dispute-evidence-note" />
      <Submit pending={pending} testid="dispute-evidence-submit" label="Attach evidence" />
    </form>
  );
}

/** Buyer withdrawal — the order resumes to its pre-dispute status. */
export function WithdrawDisputeButton({ orderId, disputeId }: { orderId: string; disputeId: string }) {
  const [state, action, pending] = useActionState(withdrawDisputeAction, null);
  return (
    <form action={action} className="inline" data-testid="dispute-withdraw">
      <Feedback state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="disputeId" value={disputeId} />
      <Submit pending={pending} testid="dispute-withdraw-submit" label="Withdraw dispute" tone="quiet" />
    </form>
  );
}

/** Staff pickup: OPEN → UNDER_REVIEW. */
export function StartDisputeReviewButton({ orderId, disputeId }: { orderId: string; disputeId: string }) {
  const [state, action, pending] = useActionState(startDisputeReviewAction, null);
  return (
    <form action={action} className="inline" data-testid="dispute-start-review">
      <Feedback state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="disputeId" value={disputeId} />
      <Submit pending={pending} testid="dispute-start-review-submit" label="Start review" tone="quiet" />
    </form>
  );
}
