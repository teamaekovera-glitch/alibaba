import type { Metadata } from "next";
import Link from "next/link";
import { CATEGORY_TAXONOMY } from "@packsource/db";
import { DemoDataBanner } from "@packsource/ui";

/**
 * Buyer landing page: the discovery entry point. Category families come from
 * the live taxonomy module (not a hardcoded list) so the grid can never drift
 * from what search facets count. Public by design — guest browsing is the
 * storefront default (spec §discovery).
 */
export const metadata: Metadata = {
  title: "PackSource — source packaging from verified suppliers",
  description:
    "Faceted, typo-tolerant, visual discovery across Aekovera-vetted packaging suppliers.",
};

export default function BuyerLandingPage() {
  const families = CATEGORY_TAXONOMY.map((family) => ({ slug: family.slug, name: family.name }));

  return (

    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <DemoDataBanner />

      <section className="py-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
          Source packaging from verified suppliers
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-neutral-500">
          Search 1,200+ live listings across nine packaging families — filter by material, MOQ,
          lead time, certifications, and location, or upload a photo to find lookalikes.
        </p>
        <form action="/search" method="get" className="mx-auto mt-6 flex max-w-xl gap-2">
          <input
            type="search"
            name="q"
            placeholder="Search packaging — “32 oz PET bottle”, “stand-up pouch”…"
            className="w-full rounded-md border border-neutral-300 px-4 py-2 text-sm focus:border-brand-600 focus:outline-none"
            aria-label="Search packaging listings"
          />
          <button
            type="submit"
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Search
          </button>
        </form>
        <Link
          href="/search/visual"
          className="mt-3 inline-block text-sm text-brand-700 hover:underline"
        >
          Or search by image →
        </Link>
      </section>

      <section className="py-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Browse by family
        </h2>
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="family-grid">
          {families.map((family) => (
            <li key={family.slug}>
              <Link
                href={`/search?categoryFamily=${family.slug}`}
                className="flex h-24 items-center justify-center rounded-lg border border-neutral-200 bg-white text-center text-sm font-medium text-neutral-800 hover:border-brand-300 hover:bg-brand-50"
                data-testid={`family-${family.slug}`}
              >
                {family.name}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-4 py-6 sm:grid-cols-3">
        <Link
          href="/co-man"
          className="rounded-lg border border-neutral-200 bg-white p-5 hover:border-brand-300"
          data-testid="coman-entry-card"
        >
          <h3 className="font-medium text-neutral-900">Co-manufacturing partners</h3>
          <p className="mt-1 text-sm text-neutral-500">
            Find co-packers and co-manufacturers by capability and location.
          </p>
        </Link>
        <Link
          href="/compare"
          className="rounded-lg border border-neutral-200 bg-white p-5 hover:border-brand-300"
        >
          <h3 className="font-medium text-neutral-900">Compare listings</h3>
          <p className="mt-1 text-sm text-neutral-500">
            Side-by-side specs, MOQ ladders, and lead times for up to four listings.
          </p>
        </Link>
        <Link
          href="/rfq"
          className="rounded-lg border border-neutral-200 bg-white p-5 hover:border-brand-300"
        >
          <h3 className="font-medium text-neutral-900">Request quotes</h3>
          <p className="mt-1 text-sm text-neutral-500">
            Send RFQs to matched suppliers and negotiate with landed-cost clarity.
          </p>
        </Link>
      </section>

      <p className="py-4 text-center text-sm text-neutral-500">
        Supplier?{" "}
        <Link href="/listings" className="text-brand-700 hover:underline">
          Manage your catalog in the listing console →
        </Link>
      </p>
    </div>
  );
}
