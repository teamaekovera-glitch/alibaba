"use server";

import {
  IllegalListingTransitionError,
  IncompleteListingError,
  ListingInputError,
  ListingNotEditableError,
  PermissionDeniedError,
  RecordNotFoundError,
  SpecExtractionUnconfirmedError,
  extractSpecSuggestions,
  importListingsCsv,
  importReportToCsv,
  suggestImageTags,
  type ListingRepository,
  type ListingTransitionAction,
} from "@packsource/core";
import { attributeSetForSlug } from "@packsource/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { llm, storage, vision } from "@/lib/adapters";
import { listingRepository } from "@/lib/org-scoped";
import { parseListingUpsertForm } from "@/lib/listing-form";

/**
 * Supplier listing-management server actions. Every mutation goes through the
 * org-scoped, permission-gated ListingRepository — these handlers only parse
 * form input, run the mock AI adapters, and translate domain errors into
 * form-renderable messages. Nothing here touches Prisma directly or trusts
 * the client beyond FormData.
 */

export type ListingActionState =
  | { ok: true; message?: string }
  | { error: string }
  | null;

export type ImportActionState =
  | { ok: true; message: string; errorCsv: string; importedCount: number; totalRows: number }
  | { error: string }
  | null;

const DOMAIN_ERRORS = [
  PermissionDeniedError,
  ListingInputError,
  IllegalListingTransitionError,
  ListingNotEditableError,
  IncompleteListingError,
  SpecExtractionUnconfirmedError,
  RecordNotFoundError,
] as const;

async function withListings(
  run: (repo: ListingRepository) => Promise<string | void>,
): Promise<ListingActionState> {
  const repo = await listingRepository();
  if (!repo) {
    redirect("/sign-in");
  }
  let message: string | undefined;
  try {
    message = (await run(repo)) || undefined;
  } catch (error) {
    if (DOMAIN_ERRORS.some((kind) => error instanceof kind)) {
      return { error: error instanceof Error ? error.message : "Action failed" };
    }
    throw error; // unknown errors must surface, not become form copy
  }
  revalidatePath("/listings");
  return { ok: true, message };
}

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

// ---------- CRUD ----------

export async function createListing(_prev: ListingActionState, form: FormData): Promise<ListingActionState> {
  const parsed = parseListingUpsertForm(form);
  if (!parsed.ok) {
    return { error: parsed.error };
  }
  return withListings(async (repo) => {
    const listing = await repo.createListing(parsed.input);
    return `Listing draft "${listing.title}" created.`;
  });
}

export async function updateListingDraft(_prev: ListingActionState, form: FormData): Promise<ListingActionState> {
  const listingId = str(form, "listingId");
  const parsed = parseListingUpsertForm(form);
  if (!parsed.ok) {
    return { error: parsed.error };
  }
  return withListings(async (repo) => {
    const { moqTiers, leadTimeRules, variants, ...core } = parsed.input;
    await repo.updateListingDraft(listingId, core);
    if (moqTiers) await repo.replaceMoqLadder(listingId, moqTiers);
    if (leadTimeRules) await repo.replaceLeadTimeRules(listingId, leadTimeRules);
    if (variants) await repo.replaceVariants(listingId, variants);
  });
}

const TRANSITION_ACTIONS: readonly ListingTransitionAction[] = [
  "submit",
  "publish",
  "reject",
  "unpublish",
  "republish",
  "resumeEditing",
  "withdraw",
  "revise",
];

export async function transitionListing(_prev: ListingActionState, form: FormData): Promise<ListingActionState> {
  const listingId = str(form, "listingId");
  const action = str(form, "transition");
  if (!TRANSITION_ACTIONS.includes(action as ListingTransitionAction)) {
    return { error: `unknown transition "${action}"` };
  }
  return withListings(async (repo) => {
    switch (action as ListingTransitionAction) {
      case "submit":
        await repo.submitForReview(listingId);
        return "Listing submitted for review.";
      case "publish":
        await repo.publish(listingId);
        return "Listing published.";
      case "reject":
        await repo.reject(listingId, str(form, "reason") || "Rejected by reviewer");
        return "Listing rejected and returned to the supplier.";
      case "unpublish":
        await repo.unpublish(listingId);
        return "Listing unpublished.";
      case "republish":
        await repo.republish(listingId);
        return "Listing republished.";
      case "resumeEditing":
        await repo.resumeEditing(listingId);
        return "Listing reopened for editing.";
      case "withdraw":
        await repo.withdraw(listingId);
        return "Listing withdrawn from review.";
      case "revise":
        await repo.revise(listingId);
        return "Listing returned to draft for revision.";
    }
  });
}

// ---------- Spec-sheet extraction (reasoning mock) ----------

export async function uploadSpecSheet(_prev: ListingActionState, form: FormData): Promise<ListingActionState> {
  const listingId = str(form, "listingId");
  const file = form.get("specSheet");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "attach a spec sheet file first" };
  }
  return withListings(async (repo) => {
    const specText = await file.text();
    const stored = await storage.put(
      `spec-sheets/${crypto.randomUUID()}-${file.name}`,
      new Uint8Array(await file.arrayBuffer()),
      file.type || "text/plain",
    );
    const sheet = await repo.addSpecSheet(listingId, { fileId: stored.key, title: file.name });

    // Reasoning adapter (mock): the deterministic extractor produces the
    // suggestions; the adapter pass supplies the model provenance. In mock
    // mode nothing leaves the process and no API keys exist.
    let reasoningModel = "mock-reasoning";
    try {
      const completion = await llm.complete({
        system: "Extract structured packaging attributes from supplier spec sheets.",
        messages: [{ role: "user", content: specText.slice(0, 4000) }],
        maxTokens: 256,
      });
      reasoningModel = completion.model;
    } catch {
      // The deterministic extractor below owns the suggestions; an adapter
      // hiccup must not strand the sheet as UPLOADED.
    }

    const categorySlug = str(form, "categorySlug");
    const attributeSet = attributeSetForSlug(categorySlug);
    if (!attributeSet) {
      throw new RecordNotFoundError("category attribute set", categorySlug);
    }
    const payload = extractSpecSuggestions(specText, attributeSet);
    const withProvenance = { ...payload, reasoningModel };
    await repo.recordSpecExtraction(listingId, sheet.id, withProvenance);
    return `${payload.suggestions.length} attribute suggestions extracted from "${file.name}" — review and confirm below.`;
  });
}

export async function applySpecSuggestions(_prev: ListingActionState, form: FormData): Promise<ListingActionState> {
  const listingId = str(form, "listingId");
  const specSheetId = str(form, "specSheetId");
  return withListings(async (repo) => {
    await repo.applySpecSuggestions(listingId, specSheetId);
    return "Suggestions applied to the draft — edit the fields below, then confirm the extraction.";
  });
}

export async function confirmSpecSheet(_prev: ListingActionState, form: FormData): Promise<ListingActionState> {
  const listingId = str(form, "listingId");
  const specSheetId = str(form, "specSheetId");
  return withListings(async (repo) => {
    await repo.confirmSpecSheet(listingId, specSheetId);
    return "Extraction confirmed — this sheet no longer blocks publishing.";
  });
}

// ---------- Image upload (vision mock) ----------

export async function uploadImage(_prev: ListingActionState, form: FormData): Promise<ListingActionState> {
  const listingId = str(form, "listingId");
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "attach an image first" };
  }
  return withListings(async (repo) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await storage.put(
      `listing-images/${crypto.randomUUID()}-${file.name}`,
      bytes,
      file.type || "image/jpeg",
    );
    // Vision adapter (mock): deterministic labels + input fingerprint; the
    // suggestion is stored as pending until a human confirms it.
    const classified = await vision.classify({
      base64: Buffer.from(bytes).toString("base64"),
      mimeType: file.type || "image/jpeg",
    });
    const suggestion = suggestImageTags(classified);
    await repo.addImage(listingId, {
      url: stored.key,
      suggestedTags: suggestion.tags,
      suggestedAlt: suggestion.suggestedAlt,
    });
    return `Image uploaded with ${suggestion.tags.length} suggested tags — review below.`;
  });
}

export async function confirmImage(_prev: ListingActionState, form: FormData): Promise<ListingActionState> {
  const listingId = str(form, "listingId");
  const position = Number(str(form, "position"));
  if (!Number.isInteger(position) || position < 0) {
    return { error: "invalid image position" };
  }
  const alt = str(form, "alt");
  return withListings(async (repo) => {
    await repo.confirmImage(listingId, position, alt === "" ? undefined : alt);
    return "Image suggestion confirmed.";
  });
}

// ---------- Bulk CSV import ----------

export async function importListings(_prev: ImportActionState, form: FormData): Promise<ImportActionState> {
  const file = form.get("csvFile");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "attach a CSV file first" };
  }
  const repo = await listingRepository();
  if (!repo) {
    redirect("/sign-in");
  }
  try {
    const csvText = await file.text();
    const report = await importListingsCsv(repo, csvText);
    revalidatePath("/listings");
    return {
      ok: true,
      message: `Imported ${report.importedCount} of ${report.totalRows} rows; ${report.skippedCount} skipped (see report).`,
      errorCsv: importReportToCsv(report),
      importedCount: report.importedCount,
      totalRows: report.totalRows,
    };
  } catch (error) {
    if (DOMAIN_ERRORS.some((kind) => error instanceof kind)) {
      return { error: error instanceof Error ? error.message : "Import failed" };
    }
    throw error;
  }
}
