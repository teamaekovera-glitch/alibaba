"use client";

import { useActionState } from "react";
import type { ActionState } from "./actions";
import {
  moderateReviewAction,
  removeMemberAction,
  resolveDisputeAction,
  runReorderSweepAction,
  setMemberRoleAction,
  setVerificationTierAction,
} from "./actions";

/**
 * Admin console forms (client components). Same useActionState + Feedback +
 * Submit pattern as the order forms; every form carries hidden identifiers
 * and data-testids so integration tests and QA evidence can target them.
 */

const inputClass = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-xs font-medium text-neutral-600";

function Feedback({ state }: { state: ActionState }) {
  if (!state) {
    return null;
  }
  if ("error" in state) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="form-error">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" data-testid="form-ok">
        {state.message}
      </p>
    );
  }
  return null;
}

function Submit({ pending, testid, children }: { pending: boolean; testid: string; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      data-testid={testid}
      className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}

/** Publish / reject controls for one pending review. */
export function ModerationForm({ reviewId }: { reviewId: string }) {
  const [publishState, publish, publishPending] = useActionState(moderateReviewAction, null);
  const [rejectState, reject, rejectPending] = useActionState(moderateReviewAction, null);
  return (
    <div className="mt-3 flex flex-col gap-2">
      <Feedback state={publishState ?? rejectState} />
      <div className="flex flex-wrap items-center gap-2">
        <form action={publish} className="contents">
          <Hidden name="reviewId" value={reviewId} />
          <Hidden name="decision" value="PUBLISHED" />
          <Submit pending={publishPending} testid={`moderate-publish-${reviewId}`}>Publish</Submit>
        </form>
        <form action={reject} className="contents">
          <Hidden name="reviewId" value={reviewId} />
          <Hidden name="decision" value="REJECTED" />
          <input name="reason" placeholder="Rejection reason" className={`${inputClass} max-w-xs`} data-testid={`moderate-reason-${reviewId}`} />
          <Submit pending={rejectPending} testid={`moderate-reject-${reviewId}`}>Reject</Submit>
        </form>
      </div>
    </div>
  );
}

/** Escrow-aware resolution controls for one dispute. */
export function DisputeResolutionForm({ disputeId }: { disputeId: string }) {
  const [state, submit, pending] = useActionState(resolveDisputeAction, null);
  return (
    <form action={submit} className="mt-3 flex flex-col gap-2">
      <Feedback state={state} />
      <Hidden name="disputeId" value={disputeId} />
      <label className={labelClass}>
        Outcome
        <select name="kind" className={inputClass} data-testid={`dispute-resolution-${disputeId}`} defaultValue="RELEASE">
          <option value="RELEASE">Release escrow to supplier</option>
          <option value="FULL_REFUND">Full refund to buyer</option>
          <option value="PARTIAL_REFUND">Partial refund (enter amount)</option>
          <option value="BACK_TO_DELIVERED">Return order to delivered</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <label className={labelClass}>
          Refund amount (cents, partial refunds)
          <input name="amountCents" inputMode="numeric" placeholder="e.g. 12500" className={inputClass} data-testid={`dispute-amount-${disputeId}`} />
        </label>
        <label className={labelClass}>
          Reason / note
          <input name="note" placeholder="Required for refunds" className={inputClass} data-testid={`dispute-note-${disputeId}`} />
        </label>
      </div>
      <Submit pending={pending} testid={`dispute-resolve-${disputeId}`}>Resolve dispute</Submit>
    </form>
  );
}

/** Verification tier controls for one supplier org. */
export function VerificationForm({ orgId, currentTier }: { orgId: string; currentTier: string }) {
  const [state, submit, pending] = useActionState(setVerificationTierAction, null);
  return (
    <form action={submit} className="mt-3 flex flex-col gap-2">
      <Feedback state={state} />
      <Hidden name="orgId" value={orgId} />
      <label className={labelClass}>
        Verification tier
        <select name="tier" className={inputClass} data-testid={`verification-tier-${orgId}`} defaultValue={currentTier}>
          <option value="UNVERIFIED">UNVERIFIED</option>
          <option value="VERIFIED">VERIFIED</option>
          <option value="AEKOVERA_VETTED">AEKOVERA_VETTED</option>
        </select>
      </label>
      <input name="note" placeholder="Note (optional)" className={inputClass} />
      <Submit pending={pending} testid={`verification-submit-${orgId}`}>Update verification</Submit>
    </form>
  );
}

/** Role selector + remove control for one org membership. */
export function MemberAdminForm({ membershipId, currentRole }: { membershipId: string; currentRole: string }) {
  const [roleState, submitRole, rolePending] = useActionState(setMemberRoleAction, null);
  const [removeState, submitRemove, removePending] = useActionState(removeMemberAction, null);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <Feedback state={roleState ?? removeState} />
      <div className="flex flex-wrap items-center gap-2">
        <form action={submitRole} className="contents">
          <Hidden name="membershipId" value={membershipId} />
          <select name="role" className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm" defaultValue={currentRole} data-testid={`member-role-${membershipId}`}>
            <option value="OWNER">OWNER</option>
            <option value="ADMIN">ADMIN</option>
            <option value="BUYER">BUYER</option>
            <option value="APPROVER">APPROVER</option>
            <option value="SUPPLIER_SALES">SUPPLIER_SALES</option>
            <option value="SUPPLIER_OPS">SUPPLIER_OPS</option>
          </select>
          <Submit pending={rolePending} testid={`member-role-save-${membershipId}`}>Save role</Submit>
        </form>
        <form action={submitRemove} className="contents">
          <Hidden name="membershipId" value={membershipId} />
          <button
            type="submit"
            disabled={removePending}
            data-testid={`member-remove-${membershipId}`}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {removePending ? "Working…" : "Remove member"}
          </button>
        </form>
      </div>
    </div>
  );
}

/** Deterministic reorder-reminder sweep trigger. */
export function ReorderSweepForm() {
  const [state, submit, pending] = useActionState(runReorderSweepAction, null);
  return (
    <form action={submit} className="mt-4 flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-4">
      <Feedback state={state} />
      <label className={labelClass}>
        Run sweep as of (ISO 8601, blank = now)
        <input name="asOf" placeholder="2026-09-20T12:00:00Z" className={inputClass} data-testid="sweep-as-of" />
      </label>
      <Submit pending={pending} testid="run-reorder-sweep">Run reorder reminder sweep</Submit>
    </form>
  );
}
