/**
 * FormData → CreateRfqInput parsing for the buyer RFQ form. Same pattern as
 * listing-form.ts: pure functions, unit-tested, so the server action stays a
 * thin adapter (parse → call @packsource/core → translate domain errors).
 *
 * Category context rules (the defect behind the UI-RFQ repair):
 * - BROADCAST/AUCTION RFQs are matched within one taxonomy category, so the
 *   form must supply a categoryId (the repository enforces this too — this
 *   parser gives the user a form-level error instead of a domain round-trip).
 * - SINGLE RFQs target one listing: the category is inherited from that
 *   listing. The server page passes the listing context it loaded; the
 *   repository re-resolves the category from the live row so a stale context
 *   can never be persisted.
 */
import type { CreateRfqInput, RfqDestination } from "@packsource/core";
import { InvalidRfqSpecError } from "@packsource/core";

/** The listing context a server page attaches when the form is mounted with one. */
export interface RfqListingContext {
  id: string;
  title: string;
  categoryId: string;
  categoryName: string;
}

export type CreateRfqParseResult = { input: CreateRfqInput } | { errors: string[] };

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * "Austin, TX 78701" -> { city, state, country, postalCode } per the spec
 * envelope's structured destination. The lean form captures one free-text
 * line; unparsable text is rejected (never silently dropped) since the
 * envelope's destination shape cannot be built from it.
 */
export function parseDestination(raw: string | null): RfqDestination | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const match = /^(.+?),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(raw.trim());
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new InvalidRfqSpecError('destination must look like "Austin, TX 78701"');
  }
  return { city: match[1].trim(), state: match[2].toUpperCase(), country: "US", postalCode: match[3] };
}

function optionalDate(form: FormData, key: string, errors: string[]): Date | null {
  const value = text(form, key);
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    errors.push(`${key} must be a valid date`);
    return null;
  }
  return date;
}

/**
 * Parse the lean RFQ-creation form. `listing` is the server-loaded listing
 * context present when the form is mounted from a product/listing page —
 * SINGLE mode inherits the listing's category from it.
 */
export function parseCreateRfqForm(
  form: FormData,
  listing?: RfqListingContext | null,
): CreateRfqParseResult {
  const errors: string[] = [];

  const mode = text(form, "mode");
  if (mode !== "BROADCAST" && mode !== "AUCTION" && mode !== "SINGLE") {
    return { errors: ["RFQ mode must be BROADCAST, AUCTION, or SINGLE"] };
  }

  const title = text(form, "title");
  if (title.length === 0) {
    errors.push("title is required");
  }

  const quantityRaw = text(form, "quantity");
  // Number (not parseInt): "2.5" must be rejected, not truncated to 2 — the
  // line quantity is persisted as-is and the matcher compares it to MOQs.
  const quantity = Number(quantityRaw);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    errors.push("quantity must be a positive whole number");
  }

  // Category: required for broadcast modes, inherited from the listing for
  // SINGLE. `listing` is the context the caller resolved from the form's
  // listingId (page mount or server action); the repository re-resolves the
  // category from the live listing row so a stale context never persists —
  // a listing that fails to load stays null here and the repository turns
  // the unknown listing into a typed domain error.
  let categoryId: string | null = null;
  let listingId: string | null = null;
  if (mode === "SINGLE") {
    listingId = text(form, "listingId") || listing?.id || null;
    if (!listingId) {
      errors.push("a single-listing RFQ requires a target listing");
    } else {
      categoryId = listing?.categoryId ?? null;
    }
  } else {
    categoryId = text(form, "categoryId") || null;
    if (!categoryId) {
      errors.push("category is required — broadcast RFQs match suppliers within one category");
    }
  }

  let destination: RfqDestination | undefined;
  try {
    destination = parseDestination(text(form, "destination") || null);
  } catch (error) {
    if (error instanceof InvalidRfqSpecError) {
      errors.push(error.message);
    } else {
      throw error;
    }
  }

  const needBy = optionalDate(form, "needBy", errors);
  const closesAt = optionalDate(form, "closesAt", errors);

  if (errors.length > 0) {
    return { errors };
  }

  return {
    input: {
      mode,
      title,
      description: text(form, "description") || null,
      categoryId,
      listingId,
      quantity,
      closesAt: mode === "AUCTION" ? (closesAt ?? undefined) : undefined,
      spec: {
        version: 1,
        destination,
        needByDate: needBy ? needBy.toISOString().slice(0, 10) : undefined,
      },
      lines: [
        {
          description: text(form, "lineDescription") || title,
          quantity,
        },
      ],
    },
  };
}
