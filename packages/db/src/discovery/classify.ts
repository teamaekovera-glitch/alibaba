/**
 * Deterministic import-time category classifier for the discovery directory.
 *
 * Weighted keyword scoring over the record's free-text fields (spec: locked
 * decision — deterministic, import-time classification; no LLM at browse
 * time): Specialty 3x, Products 2x, Supplier Type 2x, Description 1x. Highest
 * score wins the primary category; ties break by taxonomy card order. Other
 * categories scoring above SECONDARY_MIN_SCORE become secondary slugs (primary
 * first, capped at MAX_CATEGORY_SLUGS). Zero matches → other-general, so every
 * record lands somewhere and every count stays honest.
 *
 * A keyword "matches" a field at most once per field — repeated occurrences
 * in the same field add nothing, so long descriptions cannot out-shout a
 * precise specialty.
 */

import { DISCOVERY_CATEGORIES, OTHER_GENERAL_SLUG, type DiscoveryCategory } from "./taxonomy";

/** Field → weight, exactly as the spec's scoring table pins them. */
export const DISCOVERY_FIELD_WEIGHTS = {
  specialty: 3,
  products: 2,
  supplierType: 2,
  description: 1,
} as const;

/** Minimum non-primary score for a category to become a secondary slug. */
export const SECONDARY_MIN_SCORE = 2;

/** Total category slugs per record, primary included. */
export const MAX_CATEGORY_SLUGS = 3;

export interface ClassifyInput {
  specialty?: string | null;
  products?: string | null;
  description?: string | null;
  supplierTypes?: string[] | null;
}

export interface ClassifyResult {
  /** Exactly one of the DISCOVERY_CATEGORIES slugs — never empty. */
  primaryCategory: string;
  /** Primary first, up to MAX_CATEGORY_SLUGS; every slug is a taxonomy slug. */
  categorySlugs: string[];
  /** Total weighted score per category slug (zero for unmatched categories). */
  scores: Record<string, number>;
}

/** Keyword → compiled matcher. Word-boundary safe for hyphens and slashes. */
function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Lookarounds instead of \b so boundaries hold for non-word neighbor chars
  // ("co-packer" in "Co-Packer | Food Manufacturer", "tea" not in "team").
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
}

interface CompiledCategory {
  slug: string;
  matchers: RegExp[];
}

// Compiled once per process; the keyword table is static.
let compiled: CompiledCategory[] | null = null;

function compiledCategories(): CompiledCategory[] {
  if (compiled === null) {
    compiled = DISCOVERY_CATEGORIES.map((category) => ({
      slug: category.slug,
      matchers: category.keywords.map(keywordRegex),
    }));
  }
  return compiled;
}

/**
 * Score every category against the record's fields. Pure: same input always
 * yields the same assignment (no randomness, no locale, no time).
 */
export function classifySupplier(input: ClassifyInput): ClassifyResult {
  // One haystack per weighted field; supplier types are joined with a
  // non-word separator so adjacent values cannot create accidental phrases.
  const fields: { weight: number; text: string }[] = [
    { weight: DISCOVERY_FIELD_WEIGHTS.specialty, text: input.specialty ?? "" },
    { weight: DISCOVERY_FIELD_WEIGHTS.products, text: input.products ?? "" },
    {
      weight: DISCOVERY_FIELD_WEIGHTS.supplierType,
      text: (input.supplierTypes ?? []).join("\n"),
    },
    { weight: DISCOVERY_FIELD_WEIGHTS.description, text: input.description ?? "" },
  ];

  const scores: Record<string, number> = {};
  for (const category of compiledCategories()) {
    let score = 0;
    for (const matcher of category.matchers) {
      for (const field of fields) {
        if (field.text !== "" && matcher.test(field.text)) {
          score += field.weight;
        }
      }
    }
    scores[category.slug] = score;
  }

  // Taxonomy order is the tiebreaker: stable and reviewable.
  const ranked = [...compiledCategories()].sort(
    (a, b) => (scores[b.slug] ?? 0) - (scores[a.slug] ?? 0),
  );
  const top = ranked[0];
  // Unreachable while the taxonomy is non-empty; a hypothetically empty table
  // means no category can match, so the fallback keeps the contract.
  if (!top) {
    return { primaryCategory: OTHER_GENERAL_SLUG, categorySlugs: [OTHER_GENERAL_SLUG], scores };
  }
  const topScore = scores[top.slug] ?? 0;

  const primaryCategory = topScore > 0 ? top.slug : OTHER_GENERAL_SLUG;

  const secondaries = ranked
    .filter((category) => category.slug !== primaryCategory)
    .filter((category) => (scores[category.slug] ?? 0) >= SECONDARY_MIN_SCORE)
    .slice(0, MAX_CATEGORY_SLUGS - 1)
    .map((category) => category.slug);

  return { primaryCategory, categorySlugs: [primaryCategory, ...secondaries], scores };
}

/** Exposed for tests only: asserts the compiled table mirrors the taxonomy. */
export function discoveryCategoriesForTest(): readonly DiscoveryCategory[] {
  return DISCOVERY_CATEGORIES;
}
