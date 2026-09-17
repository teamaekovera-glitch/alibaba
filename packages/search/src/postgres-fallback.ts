import { facetCounts, keywordScore, matchesFilters, tokenize } from "./filtering";
import { tierBoost, listingGraphToDocument } from "./facets";
import { listingGraphArgs } from "./listing-graph";
import { orderMatched } from "./ordering";
import type { Prisma, PrismaClient } from "@packsource/db";
import type {
  ListingFilters,
  ListingSearchQuery,
  ListingSearchResponse,
} from "./types";

/**
 * Postgres-backed filter search — the graceful outage path. When the search
 * index is unavailable, listing discovery degrades to Prisma queries over the
 * same documents' source tables and never 500s.
 *
 * Two stages keep Prisma types honest: a coarse relational where-clause
 * (relations, JSON paths, activity windows) narrows candidates, then the
 * shared facet engine applies the exact filter semantics — including band
 * filters and geodistance, which are derived fields — on built documents.
 */

/** Coarse relational narrowing. Never stricter than `matchesFilters`. */
export function buildListingWhere(filters: ListingFilters, now: Date): Prisma.ListingWhereInput {
  const where: Prisma.ListingWhereInput = { status: "LIVE" };
  const or: Prisma.ListingWhereInput[] = [];

  if (filters.categoryFamily?.length) {
    or.push(
      { category: { slug: { in: filters.categoryFamily } } },
      { category: { parent: { slug: { in: filters.categoryFamily } } } },
    );
  }
  if (filters.format?.length) {
    or.push({ category: { slug: { in: filters.format } } });
  }
  if (filters.material?.length) {
    or.push(
      ...filters.material.map(
        (value): Prisma.ListingWhereInput => ({ attributes: { path: ["material"], equals: value } }),
      ),
    );
  }
  if (filters.printMethods?.length) {
    or.push(
      ...filters.printMethods.map(
        (value): Prisma.ListingWhereInput => ({
          attributes: { path: ["printMethod"], array_contains: value },
        }),
      ),
    );
  }
  if (filters.booleanFlags?.length) {
    // AND semantics: every selected flag must be a true attribute.
    where.AND = filters.booleanFlags.map(
      (flag): Prisma.ListingWhereInput => ({ attributes: { path: [flag], equals: true } }),
    );
  }

  const profileWhere: Prisma.SupplierProfileWhereInput = {};
  const plantWhere: Prisma.PlantWhereInput = {};
  if (filters.city?.length) plantWhere.city = { in: filters.city };
  if (filters.country?.length) plantWhere.country = { in: filters.country };
  if (Object.keys(plantWhere).length > 0) profileWhere.plants = { some: plantWhere };
  if (filters.certifications?.length) {
    profileWhere.certifications = {
      some: { type: { in: filters.certifications }, expiresAt: { gt: now } },
    };
  }
  if (filters.verificationTier?.length) {
    profileWhere.verificationStatus = { in: filters.verificationTier };
  }
  if (Object.keys(profileWhere).length > 0) {
    where.org = { supplierProfile: profileWhere };
  }

  if (filters.sustainability?.length) {
    for (const value of filters.sustainability) {
      if (value === "recyclable") {
        or.push(
          { complianceClaims: { some: { framework: "RECYCLABLE" } } },
          { attributes: { path: ["recyclability"], equals: "WIDELY_RECYCLABLE" } },
        );
      } else if (value === "compostable") {
        or.push({ complianceClaims: { some: { framework: "COMPOSTABLE" } } });
      }
    }
  }
  if (filters.featured !== undefined) {
    const active = {
      status: "ACTIVE" as const,
      startsAt: { lte: now },
      endsAt: { gt: now },
    };
    where.featuredPlacements = filters.featured === true ? { some: active } : { none: active };
  }

  return or.length > 0 ? { ...where, OR: or } : where;
}

/**
 * Filter search over Postgres. Shape and semantics match the index backends —
 * callers cannot tell the difference apart from `source: "postgres-fallback"`.
 */
export async function postgresFilterSearch(
  prisma: PrismaClient,
  query: ListingSearchQuery,
): Promise<ListingSearchResponse> {
  const filters = query.filters ?? {};
  const now = new Date();
  const tokens = tokenize(query.q);

  const graphs = await prisma.listing.findMany({
    where: buildListingWhere(filters, now),
    orderBy: { id: "asc" },
    ...listingGraphArgs,
  });

  const documents = graphs.map((graph) => listingGraphToDocument(graph, now));
  const matched = documents
    .filter((doc) => matchesFilters(doc, filters))
    .map((doc) => ({ doc, keyword: keywordScore(doc, tokens) }))
    .filter(({ keyword }) => tokens.length === 0 || keyword > 0)
    .map(({ doc, keyword }) => ({ doc, score: Math.min(1, keyword + tierBoost(doc)) }));

  const offset = query.offset ?? 0;
  const limit = query.limit ?? 10;
  const ordered = orderMatched(matched, query.sort ?? "relevance");

  return {
    hits: ordered.slice(offset, offset + limit).map(({ doc, score }) => ({
      id: doc.id,
      score: Math.min(1, score),
      document: doc,
    })),
    total: matched.length,
    facetCounts: facetCounts(matched.map(({ doc }) => doc), filters),
    source: "postgres-fallback",
  };
}
