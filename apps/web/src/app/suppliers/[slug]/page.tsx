import type { Prisma } from "@packsource/db";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import { DemoDataBanner } from "@packsource/ui";
import { listingGraphArgs, listingGraphToDocument } from "@packsource/search";

import { VerificationBadge } from "@/components/verification-badge";
import { ListingResultCard } from "@/components/listing-result-card";
import { verificationLabel } from "@/lib/format";
import { publishedSupplierReviews, supplierRatingAggregate } from "@packsource/core";

/** Buyer-visible supplier graph: profile, plants, capabilities, certifications. */
const supplierInclude = {
  supplierProfile: {
    include: { plants: true, capabilities: true, certifications: true },
  },
  listings: {
    where: { status: "LIVE" as const },
    take: 24,
    orderBy: { id: "asc" as const },
    ...listingGraphArgs,
  },
} satisfies Prisma.OrganizationInclude;

export type SupplierOrg = Prisma.OrganizationGetPayload<{ include: typeof supplierInclude }>;

async function loadSupplier(slug: string): Promise<SupplierOrg | null> {
  return db.organization.findUnique({
    where: { slug },
    include: supplierInclude,
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const org = await loadSupplier(slug);
  return { title: org ? `${org.name} — PackSource` : "Supplier not found — PackSource" };
}

export default async function SupplierProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const org = await loadSupplier(slug);
  if (!org) notFound();

  const profile = org.supplierProfile;
  // Deterministic document build for the result cards — same flattening the
  // search index uses, so supplier pages render the exact discovery cards.
  const now = new Date();
  const documents = org.listings.map((graph) => listingGraphToDocument(graph, now));
  // Verified-purchase reputation: aggregate and the newest published reviews.
  const [reviews, aggregate] = await Promise.all([
    publishedSupplierReviews(db, org.id),
    supplierRatingAggregate(db, org.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8" data-testid="supplier-profile">
      <DemoDataBanner />

      <header className="mt-4 rounded-lg border border-neutral-200 p-6" data-testid="supplier-org-card">
        <div className="flex flex-wrap items-center gap-3">
          <h1
            className="text-2xl font-semibold tracking-tight text-neutral-900"
            data-testid="supplier-name"
          >
            {org.name}
          </h1>
          {profile ? <VerificationBadge tier={profile.verificationStatus} /> : null}
        </div>
        {profile?.about ? (
          <p className="mt-3 max-w-3xl text-sm text-neutral-700">{profile.about}</p>
        ) : null}
        {profile ? (
          <p className="mt-2 text-sm text-neutral-500" data-testid="supplier-meta">
            {verificationLabel(profile.verificationStatus)} · Payment terms{" "}
            {profile.paymentTerms.replaceAll("_", " ").toLowerCase()} · {profile.plants.length}{" "}
            plant{profile.plants.length === 1 ? "" : "s"}
          </p>
        ) : null}
      </header>

      {profile ? (
        <section className="mt-8 grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">Plants</h2>
            <ul className="mt-3 space-y-2 text-sm" data-testid="supplier-plant-list">
              {profile.plants.map((plant) => (
                <li key={plant.id} className="rounded-md border border-neutral-200 p-3">
                  <p className="font-medium text-neutral-900">
                    {plant.name}
                    {plant.isPrimary ? (
                      <span className="ml-2 rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600">
                        primary
                      </span>
                    ) : null}
                  </p>
                  <p className="text-neutral-500">
                    {plant.city}
                    {plant.state ? `, ${plant.state}` : ""}, {plant.country}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">Capabilities & certifications</h2>
            <ul className="mt-3 flex flex-wrap gap-2" data-testid="supplier-capabilities">
              {profile.capabilities.map((capability) => (
                <li
                  key={capability.id}
                  className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs text-neutral-700"
                >
                  {capability.name.startsWith("category:")
                    ? capability.name.slice("category:".length).replaceAll("-", " ")
                    : capability.name}
                </li>
              ))}
            </ul>
            <ul
              className="mt-3 space-y-1 text-sm text-neutral-700"
              data-testid="supplier-certification-list"
            >
              {profile.certifications.map((certification) => (
                <li key={certification.id}>
                  {certification.type} · expires {certification.expiresAt.getUTCFullYear()}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <section className="mt-10" data-testid="supplier-reviews">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-neutral-900">Reviews</h2>
          {aggregate.count > 0 ? (
            <p className="text-sm text-neutral-600" data-testid="supplier-reviews-aggregate">
              <span className="font-medium text-neutral-900">{aggregate.average?.toFixed(1)}</span> ★ ·{" "}
              {aggregate.count} verified {aggregate.count === 1 ? "review" : "reviews"}
            </p>
          ) : null}
        </div>
        {reviews.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500" data-testid="supplier-reviews-empty">
            No published reviews yet — verified buyers review this supplier after delivered orders.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {reviews.slice(0, 5).map((review) => (
              <article key={review.id} className="rounded-lg border border-neutral-200 p-4" data-testid="supplier-review-card">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-neutral-900">{review.reviewerOrgName}</p>
                  <p className="text-xs text-neutral-500">{review.createdAt.getUTCFullYear()}</p>
                </div>
                <p className="mt-1 text-sm text-neutral-700">
                  ★ {review.qualityRating} · ☎ {review.communicationRating} · ⏱ {review.onTimeRating} · 📦{" "}
                  {review.packagingAccuracyRating}
                </p>
                {review.title ? <p className="mt-2 text-sm font-medium text-neutral-900">{review.title}</p> : null}
                {review.body ? <p className="mt-1 text-sm text-neutral-700">{review.body}</p> : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-neutral-900">Listings</h2>
        {documents.length > 0 ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="supplier-listings">
            {documents.map((document) => (
              <ListingResultCard key={document.id} result={{ document }} />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-neutral-500" data-testid="supplier-listings-empty">
            This supplier has no published listings yet.
          </p>
        )}
        <p className="mt-4 text-sm text-neutral-500">
          Looking for something specific?{" "}
          <Link href="/rfq" className="font-medium text-neutral-900 hover:underline">
            Request a quote
          </Link>{" "}
          and matching suppliers come to you.
        </p>
      </section>
    </div>
  );
}
