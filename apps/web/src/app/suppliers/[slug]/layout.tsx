import type { Metadata } from "next";
import type { ReactNode } from "react";
import { organizationJsonLd } from "@packsource/seo";
import { db } from "@/lib/db";
import { JsonLd, pageMetadata, siteOrigin } from "@/lib/seo";

/**
 * Supplier-route SEO layer (spec: SEO infrastructure): canonical metadata
 * and schema.org/Organization structured data. Purely additive — the page
 * owns all profile UI internals.
 */
export const dynamic = "force-dynamic";

type SupplierLayoutData = {
  slug: string;
  name: string;
  supplierProfile: { about: string | null; plants: { city: string; country: string; isPrimary: boolean }[] } | null;
};

async function loadSupplierForSeo(slug: string): Promise<SupplierLayoutData | null> {
  return db.organization.findFirst({
    where: { slug, type: "SUPPLIER" },
    select: {
      slug: true,
      name: true,
      supplierProfile: {
        select: { about: true, plants: { select: { city: true, country: true, isPrimary: true } } },
      },
    },
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const supplier = await loadSupplierForSeo(slug);
  return pageMetadata({
    title: supplier ? `${supplier.name} — PackSource` : "Supplier not found — PackSource",
    description: supplier?.supplierProfile?.about ?? "Verified packaging supplier on the PackSource marketplace.",
    path: `/suppliers/${slug}`,
  });
}

export default async function SupplierSeoLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supplier = await loadSupplierForSeo(slug);
  const profile = supplier?.supplierProfile;
  if (!supplier || !profile) {
    return <>{children}</>;
  }
  // Primary plant first so JSON-LD reports the most representative address.
  const locations = [...profile.plants].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const jsonld = organizationJsonLd({
    site: siteOrigin(),
    slug: supplier.slug,
    name: supplier.name,
    about: profile.about,
    locations: locations.map((plant) => ({ city: plant.city, country: plant.country })),
  });
  return (
    <>
      <JsonLd data={jsonld} />
      {children}
    </>
  );
}
