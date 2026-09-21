import type { Metadata } from "next";
import { buildPageMetadata, siteUrl as resolveSiteUrl } from "@packsource/seo";

/**
 * Thin adapter from the pure @packsource/seo builders into Next.js
 * Metadata and the JSON-LD script tag. All SEO logic lives in the package;
 * this file only bridges frameworks.
 */

/** Resolved site origin (NEXT_PUBLIC_SITE_URL or the production default). */
export function siteOrigin(): string {
  return resolveSiteUrl();
}

/** Next Metadata with canonical URL and OpenGraph for a public page. */
export function pageMetadata(input: {
  title: string;
  description: string;
  path: string;
  noIndex?: boolean;
}): Metadata {
  const meta = buildPageMetadata({ site: siteOrigin(), ...input });
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical: meta.canonicalUrl },
    openGraph: meta.openGraph,
    robots: meta.robots,
  };
}

/** Injects schema.org structured data exactly as the builders emit it. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Structured-data payloads are builder output, not user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
