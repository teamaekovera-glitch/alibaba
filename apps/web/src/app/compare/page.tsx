import type { Prisma } from "@packsource/db";
import { db } from "@/lib/db";
import Link from "next/link";
import { cookies } from "next/headers";

import { DemoDataBanner } from "@packsource/ui";

import { VerificationBadge } from "@/components/verification-badge";
import { AddToCompareButton } from "@/components/add-to-compare";
import { COMPARE_COOKIE, COMPARE_LIMIT, parseCompareSlugs } from "@/lib/compare-cookie";
import { formatLeadTimeDays, formatPriceCents, formatQuantity } from "@/lib/format";

const compareInclude = {
  category: true,
  moqTiers: { orderBy: { minQty: "asc" as const } },
  leadTimes: { orderBy: { qtyMin: "asc" as const } },
  org: { include: { supplierProfile: true } },
} satisfies Prisma.ListingInclude;

export type CompareListing = Prisma.ListingGetPayload<{ include: typeof compareInclude }>;

export const metadata = { title: "Compare listings — PackSource" };

/**
 * Side-by-side comparison of the buyer's tray (2–4 listings, cookie-backed).
 * Listed fields only — landed-cost comparison arrives with the RFQ quote cart.
 */
export default async function ComparePage() {
  const cookieStore = await cookies();
  const slugs = parseCompareSlugs(cookieStore.get(COMPARE_COOKIE)?.value);

  const listings =
    slugs.length > 0
      ? await db.listing.findMany({
          where: { slug: { in: slugs }, status: "LIVE" },
          include: compareInclude,
        })
      : [];
  // Keep the tray's order; skip slugs that vanished (deleted or un-published).
  const ordered = slugs
    .map((slug) => listings.find((listing) => listing.slug === slug))
    .filter((listing): listing is CompareListing => listing !== undefined);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8" data-testid="compare-page">
      <DemoDataBanner />
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-neutral-900">
        Compare listings
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Listed price, MOQ, and lead time side by side. Landed-cost comparison arrives with the RFQ
        quote cart.
      </p>

      {ordered.length < 2 ? (
        <div
          className="mt-8 rounded-lg border border-dashed border-neutral-300 p-8 text-center"
          data-testid="compare-empty"
        >
          <p className="text-sm text-neutral-600">
            {ordered.length === 0
              ? "Your compare tray is empty — open a listing and choose “Add to compare”."
              : `Pick at least one more listing to compare (up to ${COMPARE_LIMIT}).`}
          </p>
          <Link
            href="/search"
            className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Browse listings
          </Link>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-testid="compare-table">
            <thead>
              <tr>
                <th scope="col" className="w-40 py-2 text-left font-medium text-neutral-500">
                  Field
                </th>
                {ordered.map((listing) => (
                  <th
                    key={listing.id}
                    scope="col"
                    className="py-2 text-left font-medium text-neutral-900"
                  >
                    <Link href={`/products/${listing.slug}`} className="hover:underline">
                      {listing.title}
                    </Link>
                    <div className="mt-1">
                      <AddToCompareButton slug={listing.slug} />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <CompareRow label="Image">
                {ordered.map((listing) => {
                  const image = Array.isArray(listing.images)
                    ? (listing.images as { url?: unknown }[]).find(
                        (entry) => typeof entry?.url === "string",
                      )
                    : undefined;
                  return (
                    <td key={listing.id} className="border-b border-neutral-100 py-3">
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={typeof image.url === "string" ? image.url : ""}
                          alt={listing.title}
                          className="h-20 w-20 rounded-md border border-neutral-200 object-cover"
                        />
                      ) : (
                        <div className="h-20 w-20 rounded-md border border-neutral-200 bg-neutral-50" />
                      )}
                    </td>
                  );
                })}
              </CompareRow>
              <CompareRow label="Category">
                {ordered.map((listing) => (
                  <td key={listing.id} className="border-b border-neutral-100 py-3">
                    {listing.category.name}
                  </td>
                ))}
              </CompareRow>
              <CompareRow label="Price from">
                {ordered.map((listing) => (
                  <td
                    key={listing.id}
                    className="border-b border-neutral-100 py-3"
                    data-testid="compare-price"
                  >
                    {listing.moqTiers[0]
                      ? formatPriceCents(listing.moqTiers[0].unitPriceCents)
                      : "—"}
                  </td>
                ))}
              </CompareRow>
              <CompareRow label="MOQ">
                {ordered.map((listing) => {
                  const moq = listing.moqTiers.reduce<number | null>(
                    (min, tier) => (min === null || tier.minQty < min ? tier.minQty : min),
                    null,
                  );
                  return (
                    <td
                      key={listing.id}
                      className="border-b border-neutral-100 py-3"
                      data-testid="compare-moq"
                    >
                      {moq !== null ? `${formatQuantity(moq)} units` : "—"}
                    </td>
                  );
                })}
              </CompareRow>
              <CompareRow label="Lead time">
                {ordered.map((listing) => (
                  <td
                    key={listing.id}
                    className="border-b border-neutral-100 py-3"
                    data-testid="compare-lead"
                  >
                    {listing.leadTimes[0]
                      ? formatLeadTimeDays(listing.leadTimes[0].productionDays)
                      : "—"}
                  </td>
                ))}
              </CompareRow>
              <CompareRow label="Supplier">
                {ordered.map((listing) => (
                  <td key={listing.id} className="border-b border-neutral-100 py-3">
                    <div className="flex flex-col items-start gap-1">
                      <VerificationBadge
                        tier={listing.org.supplierProfile?.verificationStatus ?? "UNVERIFIED"}
                      />
                      <Link href={`/suppliers/${listing.org.slug}`} className="hover:underline">
                        {listing.org.name}
                      </Link>
                    </div>
                  </td>
                ))}
              </CompareRow>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CompareRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th
        scope="row"
        className="border-b border-neutral-100 py-3 text-left font-medium text-neutral-500"
      >
        {label}
      </th>
      {children}
    </tr>
  );
}
