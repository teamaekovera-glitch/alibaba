import { createAdapters } from "@packsource/ai";
import {
  visualSearchListings,
  type ListingSearchDocument,
  type VisualSearchMatch,
} from "@packsource/search";
import { db } from "@/lib/db";
import { storage } from "@/lib/adapters";
import { documentsForListings, visualUploadKey } from "@/lib/search-hydrate";

/**
 * Visual search API — the image upload path. An uploaded image is stored
 * through the storage adapter (the zero-key R2 mock by default), classifies
 * into deterministic attribute tags through the configured Vision adapter,
 * tags map to structured facet filters, and similarity ranks facet-filtered
 * listings by tag-derived cosine distance. Each result carries its full
 * search document so the storefront renders the same cards as text search.
 */
export const dynamic = "force-dynamic";

interface VisualSearchBody {
  /** Image bytes as base64. */
  base64?: unknown;
  mimeType?: unknown;
  filters?: unknown;
  limit?: unknown;
}

function parseVisualBody(body: unknown): { error: string } | { base64: string; mimeType: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "expected a JSON object body" };
  }
  const { base64, mimeType } = body as VisualSearchBody;
  if (typeof base64 !== "string" || base64.length === 0) {
    return { error: "base64 image bytes are required" };
  }
  if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
    return { error: "mimeType must be an image/* media type" };
  }
  return { base64, mimeType };
}

/** A visual match upgraded from the summary document to the full search document. */
type HydratedVisualMatch = Omit<VisualSearchMatch, "document"> & {
  document: ListingSearchDocument;
};

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = parseVisualBody(body);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const adapters = createAdapters();
    // Upload audit trail through the storage adapter (deterministic content
    // key; the mock keeps it in memory). A storage failure is a real
    // degradation — the route fails structured, never silently.
    const bytes = Uint8Array.from(atob(parsed.base64), (char) => char.charCodeAt(0));
    const upload = await storage.put(
      visualUploadKey(parsed.base64, parsed.mimeType),
      bytes,
      parsed.mimeType,
    );

    const matches = await visualSearchListings(
      db,
      adapters.vision,
      adapters.embedding,
      { base64: parsed.base64, mimeType: parsed.mimeType },
      { limit: 10 },
    );
    const documents = await documentsForListings(
      db,
      matches.map((match) => match.listingId),
    );
    // Full documents for identical card rendering; drop listings that vanished
    // between search and hydration.
    const hydrated: HydratedVisualMatch[] = [];
    for (const match of matches) {
      const document = documents.get(match.listingId);
      if (document) {
        hydrated.push({ ...match, document });
      }
    }
    return Response.json({
      mode: "visual",
      uploadKey: upload.key,
      results: hydrated,
    });
  } catch (error) {
    // Visual search degrades like text discovery: structured 503, never a 500
    // stack trace. The vision/embedding mocks do not throw; reaching here
    // means storage or Postgres itself failed.
    console.error("[/api/search/visual] visual search failed", error);
    return Response.json(
      { error: "visual search is temporarily unavailable" },
      { status: 503 },
    );
  }
}
