"use server";

import { DisputeError, PermissionDeniedError, RecordNotFoundError } from "@packsource/core";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { trustRepositories } from "@/lib/trust";
import type { ActionState } from "./actions";

/**
 * Dispute discussion server actions (responses, evidence, withdrawal, staff
 * review pickup). Same contract as the orders actions: handlers parse
 * FormData and translate domain errors into form-renderable messages — every
 * participant guard, permission gate, and redaction rule lives in
 * packages/core. Escrow resolution itself stays in orders/actions.ts via
 * OrderRepository.
 */

const DOMAIN_ERRORS = [PermissionDeniedError, RecordNotFoundError, DisputeError] as const;

async function withTrust(
  run: (trust: NonNullable<Awaited<ReturnType<typeof trustRepositories>>>) => Promise<unknown>,
  paths: string[],
): Promise<ActionState> {
  const session = await trustRepositories();
  if (!session) {
    redirect("/sign-in");
  }
  try {
    await run(session);
    for (const path of paths) {
      revalidatePath(path);
    }
    return { ok: true };
  } catch (error) {
    if (DOMAIN_ERRORS.some((kind) => error instanceof kind)) {
      return { error: error instanceof Error ? error.message : "Action failed" };
    }
    throw error; // unknown errors must surface, not become form copy
  }
}

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Buyer/supplier/staff participant: post a discussion response. */
export async function respondToDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const disputeId = str(form, "disputeId");
  const body = str(form, "body");
  return withTrust(
    async ({ disputes }) => disputes.respond(disputeId, body),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Buyer or staff: attach an evidence file reference. */
export async function attachEvidenceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const disputeId = str(form, "disputeId");
  const fileId = str(form, "fileId");
  const note = str(form, "note");
  return withTrust(
    async ({ disputes }) => disputes.attachEvidence(disputeId, { fileId, ...(note ? { note } : {}) }),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Buyer: withdraw the dispute — the order resumes to its pre-dispute status. */
export async function withdrawDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const disputeId = str(form, "disputeId");
  return withTrust(
    async ({ disputes }) => disputes.withdraw(disputeId).then(() => "Dispute withdrawn — order resumed"),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Staff: pick the dispute up for review. */
export async function startDisputeReviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const disputeId = str(form, "disputeId");
  return withTrust(
    async ({ disputes }) => disputes.startReview(disputeId).then(() => "Dispute under review"),
    ["/orders", `/orders/${orderId}`],
  );
}
