import { createSearchBackend, syncAllListings, type ListingSearchIndex } from "@packsource/search";
import { db } from "@/lib/db";

/**
 * Process-wide search backend singleton. MEILISEARCH_HOST opts into the real
 * Meilisearch client; the deterministic in-memory mock is the default
 * (mock-first, zero keys). Discovery routes go through this instance plus the
 * Postgres outage fallback — never construct index clients directly.
 */
const globalForSearch = globalThis as unknown as {
  searchIndex?: ListingSearchIndex;
  searchIndexBootstrap?: Promise<void>;
};

export const searchIndex: ListingSearchIndex =
  globalForSearch.searchIndex ?? createSearchBackend();

if (process.env.NODE_ENV !== "production") {
  globalForSearch.searchIndex = searchIndex;
}

/**
 * One-time per-process index warm-up for the mock backend: the in-memory index
 * starts empty on every server boot, so the storefront would browse zero
 * results until a listing write re-synced. Syncs every LIVE listing once,
 * idempotently. Real Meilisearch deployments skip this — their index is kept
 * in step by the listing-write queue worker. Failures are logged, never
 * swallowed, and retried on the next call instead of caching the rejection.
 */
export function ensureSearchIndexSynced(): Promise<void> {
  const usingMockBackend = !process.env.MEILISEARCH_HOST;
  if (!usingMockBackend) {
    return Promise.resolve();
  }
  globalForSearch.searchIndexBootstrap ??= syncAllListings(db, searchIndex).catch((error) => {
    console.error("[search] mock index warm-up failed — will retry on next discovery call", error);
    globalForSearch.searchIndexBootstrap = undefined;
    throw error;
  });
  return globalForSearch.searchIndexBootstrap;
}
