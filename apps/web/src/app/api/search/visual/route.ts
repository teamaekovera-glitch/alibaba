import { createAdapters } from "@packsource/ai";
import { visualSearchListings } from "@packsource/search";
import { db } from "@/lib/db";

/**
 * Visual search API — the image upload path. An uploaded image classifies into
 * deterministic attribute tags through the configured Vision adapter (the
 * zero-key mock by default), tags map to structured facet filters, and
 * similarity ranks facet-filtered listings by tag-derived cosine distance.
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
    const matches = await visualSearchListings(
      db,
      adapters.vision,
      adapters.embedding,
      { base64: parsed.base64, mimeType: parsed.mimeType },
      { limit: 10 },
    );
    return Response.json({
      mode: "visual",
      results: matches,
    });
  } catch (error) {
    // Visual search degrades like text discovery: structured 503, never a 500
    // stack trace. The vision/embedding mocks do not throw; reaching here
    // means Postgres itself failed.
    console.error("[/api/search/visual] visual search failed", error);
    return Response.json(
      { error: "visual search is temporarily unavailable" },
      { status: 503 },
    );
  }
}

