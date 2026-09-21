/**
 * Read-only repository over the PlatformSupplier directory. Every function is
 * a pure read — no browse-time classification, no writes. Counts are keyed by
 * primary assignment so home-grid numbers always match the rows a category
 * page renders.
 */

import type { PlatformSupplier, PrismaClient } from "@prisma/client";
import { DISCOVERY_CATEGORY_SLUGS } from "./taxonomy";

export interface CategoryFacetType {
  type: string;
  n: number;
}

export interface ListByCategoryQuery {
  slug: string;
  /** 1-based page number. */
  page?: number;
  /** Default 24 per the spec's marketplace grid. */
  pageSize?: number;
  /** Exact supplier-type facet value (from facetTypes). */
  supplierType?: string;
  /** Default "tier" sorts by tier asc (1 = strongest, nulls last) then name. */
  sort?: "tier" | "name";
}

export interface CategoryListing {
  items: PlatformSupplier[];
  total: number;
  /** Supplier-type distribution within the category, count desc then name. */
  facetTypes: CategoryFacetType[];
}

/** Live supplier count per discovery slug; zero for unpopulated categories. */
export async function categoryCounts(db: PrismaClient): Promise<Record<string, number>> {
  const grouped = await db.platformSupplier.groupBy({
    by: ["primaryCategory"],
    _count: { _all: true },
  });

  const counts: Record<string, number> = {};
  for (const slug of DISCOVERY_CATEGORY_SLUGS) counts[slug] = 0;
  for (const group of grouped) {
    if (group.primaryCategory in counts) {
      counts[group.primaryCategory] = group._count._all;
    }
  }
  return counts;
}

/**
 * Paginated supplier grid for one category: 24 per page, tier-then-name order
 * (tier nulls last — PostgreSQL ASC default), optional exact supplier-type
 * facet filter, and the category's facet distribution for the chip row.
 */
export async function listByCategory(
  db: PrismaClient,
  query: ListByCategoryQuery,
): Promise<CategoryListing> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = query.pageSize ?? 24;

  const where = {
    primaryCategory: query.slug,
    ...(query.supplierType === undefined ? {} : { supplierTypes: { has: query.supplierType } }),
  };

  const orderBy =
    query.sort === "name"
      ? [{ name: "asc" as const }, { tier: "asc" as const }]
      : [{ tier: "asc" as const }, { name: "asc" as const }];

  const [total, items, facetRows] = await Promise.all([
    db.platformSupplier.count({ where }),
    db.platformSupplier.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.$queryRaw<CategoryFacetType[]>`
      SELECT t AS "type", COUNT(*)::int AS n
      FROM "PlatformSupplier" p, UNNEST(p."supplierTypes") AS t
      WHERE p."primaryCategory" = ${query.slug}
      GROUP BY t
      ORDER BY n DESC, t ASC`,
  ]);

  return { items, total, facetTypes: facetRows };
}

/** One directory record by slug; null for unknown slugs (404 upstream). */
export async function getDirectorySupplier(
  db: PrismaClient,
  slug: string,
): Promise<PlatformSupplier | null> {
  return db.platformSupplier.findUnique({ where: { slug } });
}
