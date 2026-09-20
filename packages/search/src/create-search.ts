import { MockListingSearch } from "./mock-faceted-search";
import { MeilisearchListingSearch, meilisearchConfigFromEnv } from "./meilisearch-adapter";
import type { ListingSearchIndex } from "./types";

export type { MeilisearchConfig } from "./meilisearch-adapter";
export { meilisearchConfigFromEnv } from "./meilisearch-adapter";

/**
 * Backend selection: MEILISEARCH_HOST opts a deployment into the real
 * Meilisearch client; otherwise the deterministic in-memory mock serves
 * (mock-first, zero keys). Both satisfy ListingSearchIndex, and discovery
 * (discoverListings) layers the Postgres outage fallback over either.
 */
export function createSearchBackend(
  env: Record<string, string | undefined> = process.env,
): ListingSearchIndex {
  const config = meilisearchConfigFromEnv(env);
  return config ? new MeilisearchListingSearch(config) : new MockListingSearch();
}
