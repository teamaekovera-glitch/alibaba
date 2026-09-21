import type { Prisma } from "@packsource/db";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import { DemoDataBanner } from "@packsource/ui";

import { VerificationBadge } from "@/components/verification-badge";
import { AddToCompareButton } from "@/components/add-to-compare";
import { loadReviewsSectionData, ReviewsSection } from "./reviews-section";
import {
  formatLeadTimeDays,
  formatPriceCents,
  formatQuantity,
  verificationLabel,
} from "@/lib/format";
import { attributeRows } from "@/lib/product-attributes";

/** Full product-page graph, typed from the Prisma include below. */
const productInclude = {
  category: true,
  moqTiers: { orderBy: { minQty: "asc" as const } },
  leadTimes: { include: { shipFromPlant: true }, orderBy: { qtyMin: "asc" as const } },
  org: {
    include: {
      supplierProfile: {
        include: { plants: true, capabilities: true, certifications: true },
      },
    },
  },
} satisfies Prisma.ListingInclude;

export type ProductListing = Prisma.ListingGetPayload<{ include: typeof productInclude }>;

async function loadProduct(slug: string): Promise<ProductListing | null> {
  const listing = await db.listing.findUnique({
    where: { slug },
    include: productInclude,
  });
  // Buyer surfaces show LIVE listings only — moderation states stay supplier-side.
  if (!listing || listing.status !== "LIVE") return null;
  return listing;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const listing = await loadProduct(slug);
  return { title: listing ? `${listing.title} — PackSource` : "Listing not found — PackSource" };
}

type GalleryImage = { url: unknown; alt?: unknown };

function Gallery({ images, title }: { images: GalleryImage[]; title: string }) {
  const usable = images
    .filter((image): image is { url: string; alt?: unknown } => typeof image?.url === "string")
    .slice(0, 4);
  const [primary, ...rest] = usable;
  if (!primary) {
    return (
      <div
        data-testid="product-gallery-empty"
        className="flex aspect-square items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-sm text-neutral-400"
      >
        No image available
      </div>
    );
  }
  return (
    <div data-testid="product-gallery">
      {/* Placeholder art: every seeded image of a listing shares one category
          artwork — the gallery structure is real, the art is demo. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={primary.url}
        alt={typeof primary.alt === "string" ? primary.alt : title}
        className="aspect-square w-full rounded-lg border border-neutral-200 bg-white object-cover"
      />
      {rest.length > 0 ? (
        <div className="mt-2 flex gap-2">
          {rest.map((image, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={index}
              src={image.url}
              alt={typeof image.alt === "string" ? image.alt : `${title} view ${index + 1}`}
              className={`h-16 w-16 rounded-md border object-cover ${
                index === 0 ? "border-neutral-900" : "border-neutral-200"
              }`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const listing = await loadProduct(slug);
  if (!listing) notFound();

  const profile = listing.org.supplierProfile;
  const primaryPlant = profile?.plants.find((plant) => plant.isPrimary) ?? profile?.plants[0];
  const priceFrom = listing.moqTiers[0];
  const moqFrom = listing.moqTiers.reduce<number | null>(
    (min, tier) => (min === null || tier.minQty < min ? tier.minQty : min),
    null,
  );
  const leadFrom = listing.leadTimes[0];
  const rows = attributeRows(
    listing.category.attributeSet as Parameters<typeof attributeRows>[0],
    listing.attributes as Record<string, unknown>,
  );

  const reviewsData = await loadReviewsSectionData(listing.id, listing.orgId);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8" data-testid="product-page">
      <DemoDataBanner />

      <nav className="mt-4 text-sm text-neutral-500" aria-label="Breadcrumb">
        <Link href="/search" className="hover:text-neutral-900">
          Search
        </Link>
        <span className="mx-1">/</span>
        <span>{listing.category.name}</span>
      </nav>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Gallery
          images={
            Array.isArray(listing.images) ? (listing.images as GalleryImage[]) : []
          }
          title={listing.title}
        />

        <div>
          <h1
            className="text-2xl font-semibold tracking-tight text-neutral-900"
            data-testid="product-title"
          >
            {listing.title}
          </h1>
          {profile ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-neutral-600">
              <VerificationBadge tier={profile.verificationStatus} />
              <Link
                href={`/suppliers/${listing.org.slug}`}
                className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                data-testid="supplier-link"
              >
                {listing.org.name}
              </Link>
            </div>
          ) : null}

          <dl className="mt-4 grid grid-cols-3 gap-3 text-sm" data-testid="product-summary">
            <div className="rounded-md border border-neutral-200 p-3">
              <dt className="text-neutral-500">Price from</dt>
              <dd className="font-medium text-neutral-900" data-testid="price-from">
                {priceFrom ? formatPriceCents(priceFrom.unitPriceCents) : "—"}
              </dd>
            </div>
            <div className="rounded-md border border-neutral-200 p-3">
              <dt className="text-neutral-500">MOQ</dt>
              <dd className="font-medium text-neutral-900" data-testid="moq-from">
                {moqFrom !== null ? formatQuantity(moqFrom) : "—"}
              </dd>
            </div>
            <div className="rounded-md border border-neutral-200 p-3">
              <dt className="text-neutral-500">Lead time</dt>
              <dd className="font-medium text-neutral-900" data-testid="lead-time">
                {leadFrom ? formatLeadTimeDays(leadFrom.productionDays) : "—"}
              </dd>
            </div>
          </dl>

          <p className="mt-4 text-sm text-neutral-700">{listing.description}</p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/rfq"
              data-testid="request-quote"
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              Request a quote
            </Link>
            <AddToCompareButton slug={listing.slug} />
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            Quotes are computed from listed MOQ, lead time, and destination — no hidden fees.
          </p>
        </div>
      </div>

      <section className="mt-10 grid gap-8 lg:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">MOQ price ladder</h2>
          {listing.moqTiers.length > 0 ? (
            <table className="mt-3 w-full text-sm" data-testid="moq-ladder">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th scope="col" className="py-2 font-medium">
                    Quantity
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Unit price
                  </th>
                </tr>
              </thead>
              <tbody>
                {listing.moqTiers.map((tier) => (
                  <tr key={tier.minQty} className="border-b border-neutral-100">
                    <td className="py-2 text-neutral-900">{formatQuantity(tier.minQty)}+</td>
                    <td className="py-2 text-right text-neutral-900">
                      {formatPriceCents(tier.unitPriceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">
              No price ladder published for this listing.
            </p>
          )}
        </div>

        <div>
          <h2 className="text-lg font-semibold text-neutral-900">Lead times</h2>
          {listing.leadTimes.length > 0 ? (
            <table className="mt-3 w-full text-sm" data-testid="lead-time-bands">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th scope="col" className="py-2 font-medium">
                    Quantity range
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Production
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Ships from
                  </th>
                </tr>
              </thead>
              <tbody>
                {listing.leadTimes.map((rule, index) => (
                  <tr key={index} className="border-b border-neutral-100">
                    <td className="py-2 text-neutral-900">
                      {formatQuantity(rule.qtyMin)}–
                      {rule.qtyMax !== null ? formatQuantity(rule.qtyMax) : "∞"}
                    </td>
                    <td className="py-2 text-neutral-900">
                      {formatLeadTimeDays(rule.productionDays)}
                    </td>
                    <td className="py-2 text-neutral-900">
                      {rule.shipFromPlant
                        ? `${rule.shipFromPlant.city}, ${rule.shipFromPlant.country}`
                        : "Any plant"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">
              No lead-time bands published for this listing.
            </p>
          )}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-neutral-900">Specifications</h2>
        {rows.length > 0 ? (
          <table className="mt-3 w-full text-sm" data-testid="attribute-table">
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-neutral-100">
                  <th scope="row" className="w-56 py-2 text-left font-medium text-neutral-500">
                    {row.label}
                  </th>
                  <td className="py-2 text-neutral-900">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">
            No specifications published for this listing.
          </p>
        )}
      </section>

      {profile ? (
        <section
          className="mt-10 rounded-lg border border-neutral-200 p-6"
          data-testid="supplier-card"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">{listing.org.name}</h2>
              <p className="mt-1 text-sm text-neutral-600">
                {verificationLabel(profile.verificationStatus)} ·{" "}
                {primaryPlant
                  ? `${primaryPlant.city}, ${primaryPlant.country}`
                  : "Location on request"}
              </p>
            </div>
            <Link
              href={`/suppliers/${listing.org.slug}`}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-900 hover:border-neutral-900"
            >
              View profile
            </Link>
          </div>

          {profile.about ? <p className="mt-3 text-sm text-neutral-700">{profile.about}</p> : null}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium text-neutral-500">Plants</h3>
              <ul className="mt-2 space-y-1 text-sm text-neutral-900" data-testid="supplier-plants">
                {profile.plants.map((plant) => (
                  <li key={plant.id}>
                    {plant.name} — {plant.city}
                    {plant.state ? `, ${plant.state}` : ""}, {plant.country}
                    {plant.isPrimary ? " (primary)" : ""}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-medium text-neutral-500">Certifications</h3>
              <ul
                className="mt-2 space-y-1 text-sm text-neutral-900"
                data-testid="supplier-certifications"
              >
                {profile.certifications.map((certification) => (
                  <li key={certification.id}>
                    {certification.type} · expires {certification.expiresAt.getUTCFullYear()}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ) : null}

<ReviewsSection slug={listing.slug} {...reviewsData} />
    </div>
  );
}
