/**
 * Input validation for listing mutations (spec: Supplier console → Listing
 * management). Category-specific attribute values are NOT validated here —
 * they validate against the category's attribute set at write time via
 * @packsource/db's Zod builders; this module covers the shape every listing
 * carries regardless of category.
 *
 * Money stays integer cents (unitPriceCents); quantities are integers ≥ 1.
 */
import { z } from "zod";
import type { ListingStatus } from "@packsource/db";

export const STOCK_LEVELS = [
  "OUT_OF_STOCK",
  "LOW",
  "IN_STOCK",
  "MADE_TO_ORDER",
] as const;
export type StockLevelValue = (typeof STOCK_LEVELS)[number];

export const LISTING_STATUSES: readonly ListingStatus[] = [
  "DRAFT",
  "PENDING_REVIEW",
  "LIVE",
  "PAUSED",
  "REJECTED",
];

export const moqTierInput = z
  .object({
    minQty: z.number().int().min(1),
    unitPriceCents: z.number().int().min(1),
  })
  .strict();

export const leadTimeRuleInput = z
  .object({
    qtyMin: z.number().int().min(1),
    qtyMax: z.number().int().min(1).nullable(),
    productionDays: z.number().int().min(1).max(365),
  })
  .strict();

export const listingImageInput = z
  .object({
    url: z.string().min(1).max(2048),
    alt: z.string().max(300).optional(),
    position: z.number().int().min(0).max(19).default(0),
  })
  .strict();

export const listingVariantInput = z
  .object({
    sku: z.string().min(1).max(64),
    barcode: z.string().min(1).max(64).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    unitPriceCents: z.number().int().min(1).optional(),
    stockQty: z.number().int().min(0).optional(),
    stockLevel: z.enum(STOCK_LEVELS).optional(),
  })
  .strict();

/** The writable core of a listing. `attributes` is validated per-category. */
export const listingCoreInput = z
  .object({
    title: z.string().min(3).max(160),
    categorySlug: z.string().min(1).max(80),
    description: z.string().max(5000).nullable().optional(),
    attributes: z.record(z.string(), z.unknown()),
    images: z.array(listingImageInput).max(10).optional(),
    stockLevel: z.enum(STOCK_LEVELS).nullable().optional(),
    capacityUnitsPerWeek: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export type ListingCoreInput = z.infer<typeof listingCoreInput>;

export const listingUpsertInput = z
  .object({
    ...listingCoreInput.shape,
    moqTiers: z.array(moqTierInput).max(20).optional(),
    leadTimeRules: z.array(leadTimeRuleInput).max(20).optional(),
    variants: z.array(listingVariantInput).max(50).optional(),
  })
  .strict();

export type ListingUpsertInput = z.infer<typeof listingUpsertInput>;

/** Raised when a payload fails the shape checks above. */
export class ListingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListingInputError";
  }
}

/** Validates a listing payload and returns typed data, or throws. */
export function parseListingUpsert(value: unknown): ListingUpsertInput {
  const result = listingUpsertInput.safeParse(value);
  if (!result.success) {
    throw new ListingInputError(
      `invalid listing payload: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/** Partial update for an existing DRAFT listing (strict — no unknown keys). */
export const listingDraftUpdateInput = listingUpsertInput.partial();

export type ListingDraftUpdateInput = z.infer<typeof listingDraftUpdateInput>;

/** Validates a partial draft-update payload and returns typed data, or throws. */
export function parseListingDraftUpdate(value: unknown): ListingDraftUpdateInput {
  const result = listingDraftUpdateInput.safeParse(value);
  if (!result.success) {
    throw new ListingInputError(
      `invalid listing update payload: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * MOQ price ladders are quantity-sorted tiers with non-increasing unit price
 * (spec: "price ladders are quantity-sorted tiers"). Checked after parsing so
 * the caller gets a field-precise error rather than a DB unique-constraint
 * failure.
 */
export function validateMoqLadder(
  tiers: readonly { minQty: number; unitPriceCents: number }[],
): void {
  for (let i = 1; i < tiers.length; i += 1) {
    const previous = tiers[i - 1];
    const current = tiers[i];
    if (previous === undefined || current === undefined) continue;
    if (current.minQty <= previous.minQty) {
      throw new ListingInputError(
        `MOQ tiers must have strictly ascending minQty (tier ${i}: ${current.minQty} after ${previous.minQty})`,
      );
    }
    if (current.unitPriceCents > previous.unitPriceCents) {
      throw new ListingInputError(
        `MOQ tiers must have non-increasing unit prices (tier at minQty ${current.minQty}: ` +
          `${current.unitPriceCents} > ${previous.unitPriceCents} at ${previous.minQty})`,
      );
    }
  }
  const seen = new Set<number>();
  for (const tier of tiers) {
    if (seen.has(tier.minQty)) {
      throw new ListingInputError(`duplicate MOQ tier minQty: ${tier.minQty}`);
    }
    seen.add(tier.minQty);
  }
}

/**
 * Lead-time bands must not overlap: each rule's [qtyMin, qtyMax] range is
 * disjoint from every other rule's (qtyMax null = open-ended above qtyMin).
 */
export function validateLeadTimeRules(
  rules: readonly { qtyMin: number; qtyMax: number | null }[],
): void {
  const sorted = [...rules].sort((a, b) => a.qtyMin - b.qtyMin);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;
    const previousMax = previous.qtyMax ?? Number.POSITIVE_INFINITY;
    if (previousMax >= current.qtyMin) {
      throw new ListingInputError(
        `lead-time bands must not overlap (${previous.qtyMin}–${previous.qtyMax ?? "∞"} vs ${current.qtyMin}+)`,
      );
    }
    if (previous.qtyMax !== null && previous.qtyMax < previous.qtyMin) {
      throw new ListingInputError(`lead-time band ${previous.qtyMin}–${previous.qtyMax} is inverted`);
    }
  }
}
