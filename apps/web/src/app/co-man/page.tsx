import type { Prisma } from "@packsource/db";
import { db } from "@/lib/db";
import Link from "next/link";

import { DemoDataBanner } from "@packsource/ui";

import { VerificationBadge } from "@/components/verification-badge";

const comanInclude = {
  supplierProfile: {
    include: { plants: true, capabilities: true, certifications: true },
  },
  listings: { where: { status: "LIVE" as const }, select: { _count: true } },
} satisfies Prisma.OrganizationInclude;

export const metadata = { title: "Co-manufacturing — PackSource" };

/** Capability names are seeded as `category:<slug>`; co-man discovery shows
 * the human part. Non-category capabilities (e.g. claimed certs) render as-is. */
function capabilityLabel(name: string): string {
  return name.startsWith("category:")
    ? name.slice("category:".length).replaceAll("-", " ")
    : name;
}

/**
 * Co-manufacturer discovery: suppliers with production capabilities, filtered
 * by a capability keyword. Equipment-level compatibility checks (filler /
 * sealer / capper specs against a buyer's line) arrive with the RFQ co-man
 * wave — this surface is discovery and contact, not line matching yet.
 */
export default async function CoManPage({
  searchParams,
}: {
  searchParams: Promise<{ capability?: string }>;
}) {
  const { capability } = await searchParams;
  const keyword = capability?.trim() ?? "";

  const orgs = await db.organization.findMany({
    where: {
      supplierProfile: { isNot: null },
      ...(keyword
        ? { capabilities: { some: { name: { contains: keyword.toLowerCase() } } } }
        : {}),
    },
    include: comanInclude,
    orderBy: { id: "asc" },
    take: 24,
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8" data-testid="co-man-page">
      <DemoDataBanner />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-neutral-900">
        Co-manufacturing partners
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-neutral-500">
        Suppliers with production capabilities across the packaging taxonomy — browse plants and
        capabilities, then request a quote to start a co-man engagement. Line-level compatibility
        checks arrive with the next wave.
      </p>

      <form className="mt-6 flex gap-2" action="/co-man" data-testid="co-man-filter">
        <input
          type="search"
          name="capability"
          defaultValue={keyword}
          placeholder="Filter by capability, e.g. bottles, closures"
          className="w-72 rounded-md border border-neutral-300 px-3 py-2 text-sm"
          aria-label="Filter by capability"
        />
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Filter
        </button>
        {keyword ? (
          <Link
            href="/co-man"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-900"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {orgs.length === 0 ? (
        <div
          className="mt-8 rounded-lg border border-dashed border-neutral-300 p-8 text-center"
          data-testid="co-man-empty"
        >
          <p className="text-sm text-neutral-600">
            {keyword
              ? `No co-manufacturers list a capability matching “${keyword}” yet — try a broader term.`
              : "No co-manufacturers are onboarded yet."}
          </p>
        </div>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="co-man-list">
          {orgs.map((org) => {
            const profile = org.supplierProfile;
            if (!profile) return null;
            const plantLocations = profile.plants
              .slice(0, 3)
              .map((plant) => plant.city)
              .join(", ");
            const listingCount = org.listings.length;
            return (
              <li
                key={org.id}
                className="rounded-lg border border-neutral-200 p-4"
                data-testid="co-man-card"
              >
                <div className="flex items-center gap-2">
                  <VerificationBadge tier={profile.verificationStatus} />
                  <h2 className="text-sm font-semibold text-neutral-900">
                    <Link href={`/suppliers/${org.slug}`} className="hover:underline">
                      {org.name}
                    </Link>
                  </h2>
                </div>
                <ul className="mt-3 flex flex-wrap gap-1">
                  {profile.capabilities.slice(0, 5).map((cap) => (
                    <li
                      key={cap.id}
                      className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-700"
                    >
                      {capabilityLabel(cap.name)}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-neutral-500">
                  {plantLocations ? `Plants: ${plantLocations}` : "Plants on request"}
                  {listingCount > 0
                    ? ` · ${listingCount} live listing${listingCount === 1 ? "" : "s"}`
                    : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
