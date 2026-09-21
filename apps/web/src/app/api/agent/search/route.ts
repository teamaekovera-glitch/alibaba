import { agentAuth, agentRateLimit, serializeAgentSearchHit, type AgentSupplierRef } from "@packsource/agent-api";
import { createAdapters } from "@packsource/ai";
import { discoverListings, discoverListingsHybrid } from "@packsource/search";
import { db } from "@/lib/db";
import { ensureSearchIndexSynced, searchIndex } from "@/lib/search";
import { documentsForListings } from "@/lib/search-hydrate";
import { parseListingQuery } from "@/lib/search-query";

/**
 * Agent-readable discovery (spec: agent surface). Mirrors the public search
 * contract (same query params via parseListingQuery), authenticates agent
 * keys instead of sessions, and serializes the stable agent shapes with
 * per-hit engine scores. Index outages degrade to Postgres exactly as the
 * storefront route does — the source is surfaced per response.
 */
export const dynamic = "force-dynamic";

/** Supplier refs for the listings referenced by results. */
async function supplierRefs(listingIds: string[]): Promise<Map<string, AgentSupplierRef>> {
  const rows = await db.listing.findMany({
    where: { id: { in: [...new Set(listingIds)] } },
    select: { id: true, org: { select: { id: true, name: true, slug: true } } },
  });
  return new Map(rows.map((row) => [row.id, row.org]));
}

export async function GET(request: Request): Promise<Response> {
  const gate = agentAuth(request);
  if (!gate.ok) {
    return gate.response;
  }
  const limit = agentRateLimit(gate.orgId, new Date());
  if (!limit.ok) {
    return limit.response;
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseListingQuery(searchParams);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    await ensureSearchIndexSynced();
    if (parsed.mode === "hybrid") {
      const matches = await discoverListingsHybrid(db, searchIndex, createAdapters().embedding, parsed);
      if (Array.isArray(matches)) {
        const documents = await documentsForListings(
          db,
          matches.map((match) => match.listingId),
        );
        const refs = await supplierRefs(matches.map((match) => match.listingId));
        const results = matches.flatMap((match) => {
          const document = documents.get(match.listingId);
          const ref = refs.get(match.listingId);
          // Drop matches whose listing vanished between search and hydration.
          return document && ref ? [serializeAgentSearchHit(document, ref, match.score)] : [];
        });
        return Response.json({ mode: "hybrid", total: results.length, results });
      }
      return Response.json({ mode: "keyword", ...matches, results: [] }); // degraded fallback response
    }

    const result = await discoverListings(db, searchIndex, parsed);
    const refs = await supplierRefs(result.hits.map((hit) => hit.document.id));
    return Response.json({
      mode: "keyword",
      source: result.source,
      total: result.total,
      results: result.hits.flatMap((hit) => {
        const ref = refs.get(hit.document.id);
        return ref ? [serializeAgentSearchHit(hit.document, ref, hit.score)] : [];
      }),
    });
  } catch (error) {
    // Index outages already degrade to Postgres inside discoverListings —
    // reaching here means Postgres itself failed. Serve a structured 503,
    // never a stack trace.
    console.error("[/api/agent/search] discovery failed", error);
    return Response.json({ error: "listing discovery is temporarily unavailable" }, { status: 503 });
  }
}
