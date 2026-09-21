import { absoluteUrl } from "./site";

/**
 * Metadata and JSON-LD builders (spec: SEO infrastructure). Pure data — no
 * Next.js imports — so the web app owns the thin adapter into Next's
 * Metadata API while these shapes stay unit-testable and portable.
 */

export interface PageMetadata {
  title: string;
  description: string;
  /** Absolute canonical URL for the page. */
  canonicalUrl: string;
  openGraph: {
    title: string;
    description: string;
    url: string;
    type: "website";
    siteName: string;
  };
  robots: { index: boolean; follow: boolean };
}

export interface BuildMetadataInput {
  site: string;
  title: string;
  description: string;
  /** Root-relative path, e.g. "/products/acme-bottle". */
  path: string;
  /** Set true on error/auth pages to keep them out of the index. */
  noIndex?: boolean;
}

/** Full per-page metadata with an absolute canonical URL. */
export function buildPageMetadata(input: BuildMetadataInput): PageMetadata {
  const canonicalUrl = absoluteUrl(input.site, input.path);
  return {
    title: input.title,
    description: input.description,
    canonicalUrl,
    openGraph: {
      title: input.title,
      description: input.description,
      url: canonicalUrl,
      type: "website",
      siteName: "PackSource",
    },
    robots: { index: !input.noIndex, follow: !input.noIndex },
  };
}

export interface ProductJsonLdInput {
  site: string;
  slug: string;
  title: string;
  description: string | null;
  /** Lowest price-tier unit price in integer cents. */
  priceCents: number | null;
  currency?: string;
  imageUrl?: string | null;
  supplierName: string;
  /** Listing last-modified instant (ISO 8601). */
  dateModified?: string;
}

/** schema.org/Product for a marketplace listing page. */
export function productJsonLd(input: ProductJsonLdInput): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.imageUrl ? { image: input.imageUrl } : {}),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    brand: { "@type": "Brand", name: input.supplierName },
    ...(input.priceCents === null
      ? {}
      : {
          offers: {
            "@type": "Offer",
            price: (input.priceCents / 100).toFixed(2),
            priceCurrency: input.currency ?? "USD",
            availability: "https://schema.org/InStock",
          },
        }),
    url: absoluteUrl(input.site, `/products/${input.slug}`),
  };
}

export interface OrganizationJsonLdInput {
  site: string;
  slug: string;
  name: string;
  about: string | null;
  logoUrl?: string | null;
  /** Primary plant city/country pairs, most relevant first. */
  locations: { city: string; country: string }[];
  /** Route prefix for the emitted url; defaults to "/suppliers" (transactional profiles). */
  basePath?: string;
}

/** schema.org/Organization for a supplier profile page. */
export function organizationJsonLd(input: OrganizationJsonLdInput): Record<string, unknown> {
  const primary = input.locations[0];
  // Directory profiles emit /directory/<slug>; the transactional default
  // stays /suppliers/<slug> for every existing call site.
  const basePath = input.basePath ?? "/suppliers";
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: input.name,
    ...(input.about ? { description: input.about } : {}),
    ...(input.logoUrl ? { logo: input.logoUrl } : {}),
    url: absoluteUrl(input.site, `${basePath}/${input.slug}`),
    ...(primary
      ? { address: { "@type": "PostalAddress", addressLocality: primary.city, addressCountry: primary.country } }
      : {}),
  };
}

export interface SitemapEntry {
  url: string;
  lastModified?: Date;
  changeFrequency: "daily" | "weekly" | "monthly";
  priority: number;
}

export interface SitemapInput {
  site: string;
  /** Root-relative static public paths with crawl priority. */
  staticPaths: { path: string; priority: number }[];
  listings: { slug: string; updatedAt: Date }[];
  suppliers: { slug: string }[];
}

/** Deterministic sitemap entries: static public surfaces, then catalog. */
export function sitemapEntries(input: SitemapInput): SitemapEntry[] {
  const statics = input.staticPaths.map((entry) => ({
    url: absoluteUrl(input.site, entry.path),
    changeFrequency: "weekly" as const,
    priority: entry.priority,
  }));
  const listingEntries = [...input.listings]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((listing) => ({
      url: absoluteUrl(input.site, `/products/${listing.slug}`),
      lastModified: listing.updatedAt,
      changeFrequency: "daily" as const,
      priority: 0.7,
    }));
  const supplierEntries = [...input.suppliers]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((supplier) => ({
      url: absoluteUrl(input.site, `/suppliers/${supplier.slug}`),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
  return [...statics, ...listingEntries, ...supplierEntries];
}

/** robots.txt rules: index everything public, block app/auth surfaces. */
export function robotsRules(site: string): { sitemap: string; disallow: string[] } {
  return {
    sitemap: absoluteUrl(site, "/sitemap.xml"),
    disallow: ["/api/", "/admin/", "/cart", "/orders", "/onboarding", "/sign-in"],
  };
}
