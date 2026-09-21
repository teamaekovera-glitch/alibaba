import type { Metadata } from "next";
import type { ReactNode } from "react";
import { productJsonLd } from "@packsource/seo";
import { db } from "@/lib/db";
import { JsonLd, pageMetadata, siteOrigin } from "@/lib/seo";

/**
 * Product-route SEO layer (spec: SEO infrastructure): canonical metadata and
 * schema.org/Product structured data. Purely additive — the page owns all
 * product UI internals.
 */
export const dynamic = "force-dynamic";

type ProductLayoutData = {
  slug: string;
  title: string;
  description: string | null;
  images: unknown;
  updatedAt: Date;
  org: { name: string };
  moqTiers: { unitPriceCents: number }[];
};

async function loadProductForSeo(slug: string): Promise<ProductLayoutData | null> {
  const listing = await db.listing.findUnique({
    where: { slug },
    select: {
      slug: true,
      title: true,
      description: true,
      images: true,
      updatedAt: true,
      status: true,
      org: { select: { name: true } },
      moqTiers: { select: { unitPriceCents: true }, orderBy: { minQty: "asc" }, take: 1 },
    },
  });
  // Buyer surfaces show LIVE listings only — moderation states stay supplier-side.
  if (!listing || listing.status !== "LIVE") return null;
  return {
    slug: listing.slug,
    title: listing.title,
    description: listing.description,
    images: listing.images,
    updatedAt: listing.updatedAt,
    org: listing.org,
    moqTiers: listing.moqTiers,
  };
}

/** First well-formed image URL from the listing gallery, if any. */
function primaryImageUrl(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  for (const image of images) {
    if (image && typeof image === "object" && typeof (image as { url?: unknown }).url === "string") {
      return (image as { url: string }).url;
    }
  }
  return null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const listing = await loadProductForSeo(slug);
  return pageMetadata({
    title: listing ? `${listing.title} — PackSource` : "Listing not found — PackSource",
    description: listing?.description ?? "Packaging listing on the PackSource marketplace.",
    path: `/products/${slug}`,
  });
}

export default async function ProductSeoLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const listing = await loadProductForSeo(slug);
  if (!listing) {
    // Not-found pages carry no structured data.
    return <>{children}</>;
  }
  const jsonld = productJsonLd({
    site: siteOrigin(),
    slug: listing.slug,
    title: listing.title,
    description: listing.description,
    priceCents: listing.moqTiers[0]?.unitPriceCents ?? null,
    imageUrl: primaryImageUrl(listing.images),
    supplierName: listing.org.name,
    dateModified: listing.updatedAt.toISOString(),
  });
  return (
    <>
      <JsonLd data={jsonld} />
      {children}
    </>
  );
}
