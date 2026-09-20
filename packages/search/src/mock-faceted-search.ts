import { facetCounts, keywordScore, matchesFilters, tokenize } from "./filtering";
import { tierBoost } from "./facets";
import { orderMatched } from "./ordering";
import type {
  ListingSearchDocument,
  ListingSearchIndex,
  ListingSearchQuery,
  ListingSearchResponse,
} from "./types";

/**
 * Deterministic in-memory stand-in for the Meilisearch-backed index — the
 * default backend (mock-first, zero keys). Filtering, facet counting, and
 * keyword scoring are the shared facet engine; this class only stores
 * documents and applies ordering/pagination.
 */
export class MockListingSearch implements ListingSearchIndex {
  readonly #documents = new Map<string, ListingSearchDocument>();

  async upsert(documents: ListingSearchDocument[]): Promise<void> {
    for (const doc of documents) {
      this.#documents.set(doc.id, doc);
    }
  }

  async search(query: ListingSearchQuery): Promise<ListingSearchResponse> {
    const filters = query.filters ?? {};
    const tokens = tokenize(query.q);

    // Browse (no tokens) keeps every filter match; keyword queries require a
    // nonzero token score. Final score = keyword relevance + trust/featured boost.
    const matched = [...this.#documents.values()]
      .filter((doc) => matchesFilters(doc, filters))
      .map((doc) => ({ doc, keyword: keywordScore(doc, tokens) }))
      .filter(({ keyword }) => tokens.length === 0 || keyword > 0)
      .map(({ doc, keyword }) => ({ doc, score: Math.min(1, keyword + tierBoost(doc)) }));

    const total = matched.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 10;

    const page = orderMatched(matched, query.sort ?? "relevance").slice(offset, offset + limit);

    return {
      hits: page.map(({ doc, score }) => ({ id: doc.id, score, document: doc })),
      total,
      facetCounts: facetCounts(matched.map(({ doc }) => doc), filters),
      source: "search-index",
    };
  }

  /** Test helper: reset all documents. */
  clear(): void {
    this.#documents.clear();
  }
}

