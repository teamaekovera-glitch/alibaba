import type { PrismaClient } from "@packsource/db";
import {
  listingGraphToDocument,
  loadListingGraphs,
  type ListingSearchDocument,
} from "@packsource/search";

/**
 * Document hydration for the storefront: the hybrid and visual discovery paths
 * return listing ids (+ scores), while result cards need the full flattened
 * search document (price, MOQ, lead time, tier, certifications, location).
 * Loads the missing documents from Postgres, keyed by listing id.
 */
export async function documentsForListings(
  prisma: PrismaClient,
  listingIds: string[],
  now: Date = new Date(),
): Promise<Map<string, ListingSearchDocument>> {
  const unique = [...new Set(listingIds)];
  if (unique.length === 0) {
    return new Map();
  }

  const graphs = await loadListingGraphs(prisma, unique);
  return new Map(
    graphs.map((graph) => {
      const document = listingGraphToDocument(graph, now);
      return [document.id, document];
    }),
  );
}

/** Deterministic storage key for a visual-search upload (mock storage keeps
 * uploads in memory; the key is the audit-trail identity). */
export function visualUploadKey(base64: string, mimeType: string): string {
  const extension = mimeType.split("/")[1] ?? "bin";
  return `visual-search-uploads/${base64.length}-${extension}`;
}
