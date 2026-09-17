import { postgresFilterSearch } from "./postgres-fallback";
import type { PrismaClient } from "@packsource/db";
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
