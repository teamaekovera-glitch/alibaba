import type { EmbeddingAdapter, VisionAdapter, VisionInput } from "@packsource/ai";
import type { PrismaClient } from "@packsource/db";
import { filteredSemanticSearch } from "./semantic";
import type { ListingFilters } from "./types";

/**
 * Visual search: an image upload classifies into deterministic attribute tags
 * (Vision adapter mock), the tags map onto structured facet filters, and
 * similarity ranks listings by the cosine distance between the tag text and
 * each listing's stored TITLE embedding, scoped to those facet filters.
 */

export interface VisualTags {
  labels: string[];
  model: string;
  inputHash: string;
}

/** Classify an uploaded image through the configured Vision adapter. */
export async function visualTagsForImage(
  vision: VisionAdapter,
  image: VisionInput,
): Promise<VisualTags> {
  const result = await vision.classify(image);
  return { labels: result.labels, model: result.model, inputHash: result.inputHash };
}

/**
 * Vision-label vocabulary → facet constraints. Labels outside the vocabulary
 * become keyword text for the similarity leg rather than being dropped, so a
 * vision model's free-form labels still contribute to ranking.
 */
const MATERIAL_LABELS = new Set([
  "pet",
  "hdpe",
  "ldpe",
  "pp",
  "glass",
  "aluminum",
  "tinplate",
  "paper",
  "paperboard",
]);
const SUSTAINABILITY_LABELS = new Set(["recyclable", "compostable"]);
const FLAG_LABELS: Record<string, string> = {
  "tamper-evident": "tamperEvident",
  "hot-fill": "hotFillCapable",
  aseptic: "aseptic",
  "child-resistant": "childResistant",
};

export interface VisualTagFilters {
  filters: ListingFilters;
  /** Vocabulary labels that did not map to a facet, in given order. */
  keywordText: string;
}

/**
 * Map deterministic attribute tags onto structured filters (any-of union with
 * caller filters). Deterministic and pure — unit-tested against the mock's
 * fixed label set and mapped vocabulary labels.
 */
export function visualTagFilters(
  labels: string[],
  base: ListingFilters = {},
): VisualTagFilters {
  const filters: ListingFilters = { ...base };
  const unmatched: string[] = [];

  for (const label of labels) {
    const key = label.trim().toLowerCase();
    if (key.length === 0) continue;
    if (MATERIAL_LABELS.has(key)) {
      filters.material = [...new Set([...(filters.material ?? []), key.toUpperCase()])];
    } else if (SUSTAINABILITY_LABELS.has(key)) {
      filters.sustainability = [
        ...new Set([...(filters.sustainability ?? []), key]),
      ];
    } else if (key in FLAG_LABELS) {
      const flag = FLAG_LABELS[key]!;
      filters.booleanFlags = [...new Set([...(filters.booleanFlags ?? []), flag])];
    } else {
      unmatched.push(key);
    }
  }

  return { filters, keywordText: unmatched.join(" ") };
}

export interface VisualSearchOptions {
  /** Caller facet filters, intersected with the tag-derived filters. */
  filters?: ListingFilters;
  limit?: number;
}

export interface VisualSearchMatch {
  listingId: string;
  similarity: number;
  tags: VisualTags;
  appliedFilters: ListingFilters;
  document: {
    id: string;
    title: string;
    slug: string;
    categoryFamily: string;
  };
}

/**
 * The image upload path: classify → map tags to filters → tag-derived
 * similarity ranking over facet-filtered candidates. The semantic leg embeds
 * the tag text and ranks stored TITLE embeddings (the marketplace currently
 * stores one embedding kind per listing; visual-specific embeddings arrive
 * with real vision models).
 */
export async function visualSearchListings(
  prisma: PrismaClient,
  vision: VisionAdapter,
  embedding: EmbeddingAdapter,
  image: VisionInput,
  options: VisualSearchOptions = {},
): Promise<VisualSearchMatch[]> {
  const tags = await visualTagsForImage(vision, image);
  const tagFilters = visualTagFilters(tags.labels, options.filters);

  const candidates = await filteredSemanticSearch(prisma, embedding, {
    // Tag-derived similarity text: classify labels drive ranking when no
    // vocabulary label mapped (the mock's fixed label set).
    text: tagFilters.keywordText.length > 0 ? tagFilters.keywordText : tags.labels.join(" "),
    limit: options.limit ?? 10,
    filters: tagFilters.filters,
  });

  return candidates.map(({ match, document }) => ({
    listingId: match.listingId,
    similarity: match.similarity,
    tags,
    appliedFilters: tagFilters.filters,
    document: {
      id: document.id,
      title: document.title,
      slug: document.slug,
      categoryFamily: document.categoryFamily,
    },
  }));
}
