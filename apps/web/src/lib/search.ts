import { createSearchBackend, type ListingSearchIndex } from "@packsource/search";

/**
 * Process-wide search backend singleton. MEILISEARCH_HOST opts into the real
 * Meilisearch client; the deterministic in-memory mock is the default
 * (mock-first, zero keys). Discovery routes go through this instance plus the
 * Postgres outage fallback — never construct index clients directly.
 */
const globalForSearch = globalThis as unknown as { searchIndex?: ListingSearchIndex };

export const searchIndex: ListingSearchIndex =
  globalForSearch.searchIndex ?? createSearchBackend();

if (process.env.NODE_ENV !== "production") {
  globalForSearch.searchIndex = searchIndex;
}
