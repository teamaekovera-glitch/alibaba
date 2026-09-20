"use server";

import { PermissionDeniedError, RecordNotFoundError, type Role } from "@packsource/core";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { moderateReview, type ModerationDecision } from "@/lib/admin/moderation";
import { setVerificationTier } from "@/lib/admin/verification";
import { resolveDisputeAsStaff, type DisputeOutcomeKind } from "@/lib/admin/disputes";
import { removeMember, setMemberRole } from "@/lib/admin/directory";
import { runReorderReminderSweep } from "@packsource/notifications";
import { notificationEngine, notificationEmail } from "@/lib/notifications";
import { sessionAuthContext, staffContext } from "@/lib/admin/staff";
import { db } from "@/lib/db";

/**
 * Admin console server actions. Same contract as the order actions: handlers
 * parse FormData and translate domain errors into form-renderable messages —
 * every permission gate, state transition, and audit row lives in the
 * lib/admin layer. Signed-out visitors are redirected to /sign-in; signed-in
 * non-admins get a permission error, never a silent no-op.
 */

export type ActionState = { ok: true; message?: string } | { error: string } | null;

const DOMAIN_ERRORS = [PermissionDeniedError, RecordNotFoundError] as const;

/**
 * Shared admin-action shell: resolve the staff context (redirect guests),
 * run, revalidate, and map domain errors to form copy.
 */
async function withAdmin(
  run: (auth: NonNullable<Awaited<ReturnType<typeof staffContext>>>) => Promise<string | void>,
  paths: string[] = ["/admin"],
): Promise<ActionState> {
  const session = await sessionAuthContext();
  if (!session) {
    redirect("/sign-in");
  }
  const auth = await staffContext();
  if (!auth) {
    return { error: "You do not have permission to administer the platform." };
  }
  try {
    const result = await run(auth);
    for (const path of paths) {
      revalidatePath(path);
    }
    return { ok: true, message: typeof result === "string" ? result : undefined };
  } catch (error) {
    if (DOMAIN_ERRORS.some((kind) => error instanceof kind)) {
      return { error: error instanceof Error ? error.message : "Action failed" };
    }
    throw error; // unknown errors must surface, not become form copy
  }
}

export async function moderateReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const reviewId = String(formData.get("reviewId") ?? "");
  const decision = String(formData.get("decision") ?? "") as ModerationDecision;
  const reason = String(formData.get("reason") ?? "").trim();
  return withAdmin(
    async (auth) => {
      const result = await moderateReview(db, auth, notificationEngine(auth), {
        reviewId,
        decision,
        reason: reason || undefined,
        now: new Date(),
      });
      return `Review ${result.reviewId} ${result.moderationStatus.toLowerCase()}.`;
    },
    ["/admin", "/admin/moderation", "/notifications"],
  );
}

export async function setVerificationTierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const orgId = String(formData.get("orgId") ?? "");
  const tier = String(formData.get("tier") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  return withAdmin(
    async (auth) => {
      const result = await setVerificationTier(db, auth, notificationEngine(auth), {
        orgId,
        tier: tier as "UNVERIFIED" | "VERIFIED" | "AEKOVERA_VETTED",
        note: note || undefined,
        now: new Date(),
      });
      return `Verification ${result.from} → ${result.to}.`;
    },
    ["/admin", "/admin/verification", "/admin/organizations", "/notifications"],
  );
}

export async function resolveDisputeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const disputeId = String(formData.get("disputeId") ?? "");
  const kind = String(formData.get("kind") ?? "") as DisputeOutcomeKind;
  const amountRaw = String(formData.get("amountCents") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const amountCents = amountRaw ? Number.parseInt(amountRaw, 10) : undefined;
  return withAdmin(
    async (auth) => {
      const result = await resolveDisputeAsStaff(db, auth, notificationEngine(auth), {
        disputeId,
        kind,
        amountCents: Number.isFinite(amountCents) ? amountCents : undefined,
        note: note || undefined,
        now: new Date(),
      });
      return `Dispute resolved — order moved to ${result.resolvedTo.toLowerCase().replace(/_/g, " ")}.`;
    },
    ["/admin", "/admin/disputes", "/orders", "/notifications"],
  );
}

export async function setMemberRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const membershipId = String(formData.get("membershipId") ?? "");
  const role = String(formData.get("role") ?? "") as Role;
  return withAdmin(
    async (auth) => {
      const result = await setMemberRole(db, auth, notificationEngine(auth), {
        membershipId,
        role,
        now: new Date(),
      });
      return `Member role updated ${result.from} → ${result.to}.`;
    },
    ["/admin", "/admin/organizations", "/notifications"],
  );
}

export async function removeMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const membershipId = String(formData.get("membershipId") ?? "");
  return withAdmin(
    async (auth) => {
      const result = await removeMember(db, auth, { membershipId, now: new Date() });
      return `Member ${result.userId} removed from organization.`;
    },
    ["/admin", "/admin/organizations"],
  );
}

export async function runReorderSweepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const asOf = String(formData.get("asOf") ?? "").trim();
  const now = asOf ? new Date(asOf) : new Date();
  if (Number.isNaN(now.getTime())) {
    return { error: "Enter a valid date (ISO 8601)." };
  }
  return withAdmin(async () => {
    const result = await runReorderReminderSweep(db, notificationEmail, now);
    return `Sweep complete: ${result.notificationsSent} notification(s), ${result.emailsSent} email(s).`;
  }, ["/admin", "/admin/notifications", "/notifications"]);
}
