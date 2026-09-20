import type { EmbeddingAdapter } from "@packsource/ai";
import type { PrismaClient } from "@packsource/db";
import { postgresFilterSearch } from "./postgres-fallback";
import { hybridSearchListings, type HybridMatch } from "./semantic";
import type {
  ListingSearchIndex,
  ListingSearchQuery,
  ListingSearchResponse,
} from "./types";

/**
 * Listing discovery entry point: always resolves to a structured response,
 * never a thrown error. Index outages (network, engine crash, DNS) degrade to
 * the Postgres-backed filter search so discovery survives unavailability.
 */
export async function discoverListings(
  prisma: PrismaClient,
  index: ListingSearchIndex,
  query: ListingSearchQuery,
): Promise<ListingSearchResponse> {
  try {
    return await index.search(query);
  } catch (error) {
    // Degrade, don't fail: log the outage and serve from Postgres.
    console.error("[search] index unavailable — falling back to Postgres filter search", error);
    return postgresFilterSearch(prisma, query);
  }
}

/**
 * Hybrid discovery (keyword ∪ semantic). Non-empty queries run both paths and
 * merge with the spec's weighting; browse queries skip the semantic leg. Every
 * failure degrades: an index outage falls back to keyword/Postgres exactly like
 * discoverListings, and an empty hybrid result (embeddings not yet backfilled)
 * falls back to plain keyword discovery rather than returning zero hits.
 */
export async function discoverListingsHybrid(
  prisma: PrismaClient,
  index: ListingSearchIndex,
  embedding: EmbeddingAdapter,
  query: ListingSearchQuery,
): Promise<HybridMatch[] | ListingSearchResponse> {
  if (query.q.trim().length === 0) {
    return discoverListings(prisma, index, query);
  }
  try {
    const matches = await hybridSearchListings(prisma, index, embedding, {
      q: query.q,
      filters: query.filters,
      limit: query.limit,
      keywordWeight: 0.6,
      semanticWeight: 0.4,
    });
    if (matches.length > 0) return matches;
    return discoverListings(prisma, index, query);
  } catch (error) {
    console.error("[search] hybrid search unavailable — falling back", error);
    return postgresFilterSearch(prisma, query);
  }
}
