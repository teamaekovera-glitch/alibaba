import type { MetadataRoute } from "next";
import { sitemapEntries } from "@packsource/seo";
import { db } from "@/lib/db";
import { siteOrigin } from "@/lib/seo";

/**
 * sitemap.xml: static public surfaces plus LIVE product pages and supplier
 * profiles, deterministically ordered. Auth-gated app routes are excluded —
 * robots.txt also blocks them for crawlers that ignore the sitemap.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = siteOrigin();
  const [listings, suppliers] = await Promise.all([
    db.listing.findMany({
      where: { status: "LIVE" },
      select: { slug: true, updatedAt: true },
    }),
    db.organization.findMany({
      where: { type: "SUPPLIER", supplierProfile: { isNot: null } },
      select: { slug: true },
    }),
  ]);

  const entries = sitemapEntries({
    site,
    staticPaths: [
      { path: "/", priority: 1 },
      { path: "/search", priority: 0.9 },
      { path: "/co-man", priority: 0.8 },
      { path: "/compare", priority: 0.5 },
    ],
    listings: listings.map((listing) => ({ slug: listing.slug, updatedAt: listing.updatedAt })),
    suppliers: suppliers.map((supplier) => ({ slug: supplier.slug })),
  });
  return entries.map((entry) => ({
    url: entry.url,
    ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
    changeFrequency: entry.changeFrequency,
    priority: entry.priority,
  }));
}
