import { agentAuth, agentPage, agentRateLimit, parseAgentPaging, serializeAgentListing } from "@packsource/agent-api";
import { db } from "@/lib/db";
import { documentsForListings } from "@/lib/search-hydrate";

/**
 * Agent-readable listing feed (spec: agent surface). Bearer-key auth (org
 * mock keys), rate limited, read-only. Shape contract: packages/agent-api
 * README. Data is the same public projection the storefront renders.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = agentAuth(request);
  if (!gate.ok) {
    return gate.response;
  }
  const limit = agentRateLimit(gate.orgId, new Date());
  if (!limit.ok) {
    return limit.response;
  }

  const paging = parseAgentPaging(new URL(request.url).searchParams);
  const [rows, total] = await Promise.all([
    db.listing.findMany({
      where: { status: "LIVE" },
      orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
      skip: paging.offset,
      take: paging.limit,
      select: { id: true, org: { select: { id: true, name: true, slug: true } } },
    }),
    db.listing.count({ where: { status: "LIVE" } }),
  ]);

  const documents = await documentsForListings(
    db,
    rows.map((row) => row.id),
  );
  const data = rows.flatMap((row) => {
    const document = documents.get(row.id);
    return document ? [serializeAgentListing(document, row.org)] : [];
  });
  return agentPage(data, paging, total);
}
