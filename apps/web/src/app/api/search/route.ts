import { createAdapters } from "@packsource/ai";
import {
  discoverListings,
  discoverListingsHybrid,
  type HybridMatch,
  type ListingSearchDocument,
} from "@packsource/search";
import { db } from "@/lib/db";
import { ensureSearchIndexSynced, searchIndex } from "@/lib/search";
import { documentsForListings } from "@/lib/search-hydrate";
import { parseListingQuery } from "@/lib/search-query";

/**
 * Listing discovery API — structured JSON results (groundwork the agent-API
 * task extends). The search index backend is the configured singleton; index
 * outages degrade to the Postgres-backed filter search inside
 * discoverListings, so this route never 500s on index unavailability.
 *
 * Hybrid results arrive as id+score matches from the semantic leg, so each
 * carries its full search document (hydrated from Postgres) so the storefront
 * renders the same result cards as keyword discovery.
 */
export const dynamic = "force-dynamic";

type HybridMatchWithDocument = HybridMatch & { document: ListingSearchDocument };

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const parsed = parseListingQuery(searchParams);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    // The in-memory mock index boots empty; warm it once per process so
    // storefront discovery has documents to serve (no-op for Meilisearch).
    await ensureSearchIndexSynced();
    if (parsed.mode === "hybrid") {
      // Hybrid queries add the pgvector semantic leg; the embedding adapter is
      // the deterministic mock unless real adapters are configured.
      const matches = await discoverListingsHybrid(
        db,
        searchIndex,
        createAdapters().embedding,
        parsed,
      );
      if (Array.isArray(matches)) {
        const documents = await documentsForListings(
          db,
          matches.map((match) => match.listingId),
        );
        // Drop matches whose listing vanished between search and hydration.
        const hydrated: HybridMatchWithDocument[] = matches.flatMap((match) => {
          const document = documents.get(match.listingId);
          return document ? [{ ...match, document }] : [];
        });
        return Response.json({ mode: "hybrid", results: hydrated });
      }
      return Response.json(matches); // degraded fallback response
    }
    const result = await discoverListings(db, searchIndex, parsed);
    return Response.json(result);
  } catch (error) {
    // Index outages already degrade to Postgres inside discoverListings —
    // reaching here means Postgres itself failed. Serve a structured 503,
    // never a stack trace.
    console.error("[/api/search] discovery failed", error);
    return Response.json(
      { error: "listing discovery is temporarily unavailable" },
      { status: 503 },
    );
  }
}
