"use server";

import {
  OnboardingIncompleteError,
  PermissionDeniedError,
  ProfileSubmittedError,
  RecordNotFoundError,
} from "@packsource/core";
import type { PaymentTerms } from "@packsource/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { payments, storage } from "@/lib/adapters";
import { orgScopedRepository } from "@/lib/org-scoped";

/**
 * Supplier-onboarding server actions. Every mutation goes through the
 * org-scoped, permission-gated repository — these handlers only parse form
 * input and translate domain errors into form-renderable messages. Nothing
 * here touches Prisma directly or trusts the client beyond FormData.
 */

export type ActionState = { ok: true; message?: string } | { error: string } | null;

const DOMAIN_ERRORS = [
  PermissionDeniedError,
  ProfileSubmittedError,
  OnboardingIncompleteError,
  RecordNotFoundError,
] as const;

async function withRepo(
  run: (repo: NonNullable<Awaited<ReturnType<typeof orgScopedRepository>>>) => Promise<void>,
): Promise<ActionState> {
  const repo = await orgScopedRepository();
  if (!repo) {
    redirect("/sign-in");
  }
  try {
    await run(repo);
  } catch (error) {
    if (DOMAIN_ERRORS.some((kind) => error instanceof kind)) {
      return { error: error instanceof Error ? error.message : "Action failed" };
    }
    throw error; // unknown errors must surface, not become form copy
  }
  revalidatePath("/onboarding");
  return { ok: true };
}

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optional(form: FormData, key: string): string | null {
  const value = str(form, key);
  return value.length > 0 ? value : null;
}

function requiredDate(form: FormData, key: string): Date {
  const raw = str(form, key);
  if (!raw) {
    throw new Error(`${key} is required`);
  }
  return new Date(raw);
}

// ---------- Step 1: company profile ----------

export async function saveCompanyDetails(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withRepo(async (repo) => {
    await repo.updateCompanyDetails({
      about: str(form, "about"),
      billingEmail: optional(form, "billingEmail"),
    });
  });
}

// ---------- Step 2: plants ----------

export async function upsertPlant(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withRepo(async (repo) => {
    await repo.upsertPlant({
      id: optional(form, "plantId") ?? undefined,
      name: str(form, "name"),
      addressLine1: optional(form, "addressLine1"),
      addressLine2: optional(form, "addressLine2"),
      city: str(form, "city"),
      state: optional(form, "state"),
      postalCode: optional(form, "postalCode"),
      country: str(form, "country"),
      isPrimary: form.get("isPrimary") === "on",
    });
  });
}

export async function removePlant(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withRepo(async (repo) => {
    await repo.removePlant(str(form, "plantId"));
  });
}

// ---------- Step 3: certifications with document upload ----------

export async function upsertCertification(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withRepo(async (repo) => {
    let evidenceFileId: string | null = null;
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      // Mock Storage adapter (R2 stand-in): zero API keys, in-memory object
      // store keyed like the real bucket will be.
      const stored = await storage.put(
        `certifications/${crypto.randomUUID()}-${file.name}`,
        new Uint8Array(await file.arrayBuffer()),
        file.type || "application/octet-stream",
      );
      evidenceFileId = stored.key;
    }
    await repo.upsertCertification({
      id: optional(form, "certificationId") ?? undefined,
      type: str(form, "type"),
      number: str(form, "number"),
      issuedAt: optional(form, "issuedAt") ? requiredDate(form, "issuedAt") : null,
      expiresAt: requiredDate(form, "expiresAt"),
      evidenceFileId,
    });
  });
}

export async function removeCertification(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withRepo(async (repo) => {
    await repo.removeCertification(str(form, "certificationId"));
  });
}

// ---------- Step 4: equipment & capabilities ----------

const EQUIPMENT_KINDS = ["FILLER", "SEALER", "CAPPER", "DECORATOR", "LABELER", "OTHER"] as const;
type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

export async function upsertEquipment(_prev: ActionState, form: FormData): Promise<ActionState> {
  const kindRaw = str(form, "kind");
  if (!EQUIPMENT_KINDS.includes(kindRaw as EquipmentKind)) {
    return { error: `equipment kind must be one of: ${EQUIPMENT_KINDS.join(", ")}` };
  }
  return withRepo(async (repo) => {
    await repo.upsertEquipment({
      kind: kindRaw as EquipmentKind,
      make: optional(form, "make"),
      model: optional(form, "model"),
      specs: { note: optional(form, "specsNote") ?? "" },
    });
  });
}

export async function removeEquipment(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withRepo(async (repo) => {
    await repo.removeEquipment(str(form, "equipmentId"));
  });
}

export async function addCapability(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withRepo(async (repo) => {
    await repo.addCapability({
      name: str(form, "name"),
      detail: optional(form, "detail"),
    });
  });
}

export async function removeCapability(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withRepo(async (repo) => {
    await repo.removeCapability(str(form, "capabilityId"));
  });
}

// ---------- Step 5: MOQ & payment terms ----------

const PAYMENT_TERMS = [
  "FULL_PREPAY",
  "DEPOSIT_50_50",
  "NET_15",
  "NET_30",
  "NET_45",
  "NET_60",
] as const;

export async function saveCommercialTerms(_prev: ActionState, form: FormData): Promise<ActionState> {
  const termsRaw = str(form, "paymentTerms");
  if (!PAYMENT_TERMS.includes(termsRaw as (typeof PAYMENT_TERMS)[number])) {
    return { error: `payment terms must be one of: ${PAYMENT_TERMS.join(", ")}` };
  }
  const minOrderDollars = Number(str(form, "minOrderValueDollars"));
  if (!Number.isFinite(minOrderDollars) || minOrderDollars <= 0) {
    return { error: "minimum order value must be a positive number" };
  }
  return withRepo(async (repo) => {
    await repo.updateCommercialTerms({
      minOrderValueCents: Math.round(minOrderDollars * 100),
      paymentTerms: termsRaw as PaymentTerms,
    });
  });
}

// ---------- Step 6: Stripe Connect (Payments adapter) ----------

export async function linkStripeConnect(): Promise<ActionState> {
  // useActionState passes (state, payload); this action needs neither.
  return withRepo(async (repo) => {
    const org = await repo.organization();
    if (!org) {
      // The session references an org that no longer exists — treat as a
      // record-level failure rather than fabricating an account name.
      throw new RecordNotFoundError("organization", "current session");
    }
    // No country on the Organization model yet; mock-first default until the
    // profile carries a tax country. The mock adapter is idempotent, so
    // re-linking never mints a second account.
    const account = await payments.createConnectedAccount({
      businessName: org.name,
      country: "US",
    });
    await repo.linkStripeConnectAccount({
      accountId: account.id,
      chargesEnabled: account.chargesEnabled,
    });
  });
}

// ---------- Submit for review ----------

export async function submitForReview(): Promise<ActionState> {
  // useActionState passes (state, payload); this action needs neither.
  return withRepo(async (repo) => {
    await repo.submitForReview(new Date());
  });
}
