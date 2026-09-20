import Link from "next/link";
import { redirect } from "next/navigation";
import { LISTING_STATUSES } from "@packsource/core";
import { listingRepository } from "@/lib/org-scoped";
import { StatusBadge } from "./ui";

/**
 * Supplier listing console — the supplier's own listings with a status
 * filter. All data flows through the org-scoped repository; transitions and
 * editing live on the per-listing page.
 */
export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const repo = await listingRepository();
  if (!repo) {
    redirect("/sign-in");
  }

  const { status } = await searchParams;
  const active = LISTING_STATUSES.find((candidate) => candidate === status);
  const listings = await repo.listings(active ? { status: active } : {});

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your listings</h1>
          <p className="text-sm text-neutral-600">
            {active ? `Filtered to ${active}` : "All statuses"} — {listings.length} listing
            {listings.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/listings/new"
            data-testid="new-listing"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white"
          >
            New listing
          </Link>
          <Link
            href="/listings/import"
            data-testid="import-link"
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800"
          >
            Bulk import
          </Link>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2" data-testid="status-filter">
        <Link
          href="/listings"
          data-testid="filter-all"
          className={`rounded-full px-3 py-1 text-xs font-medium ${active ? "bg-neutral-100 text-neutral-600" : "bg-neutral-900 text-white"}`}
        >
          All
        </Link>
        {LISTING_STATUSES.map((candidate) => (
          <Link
            key={candidate}
            href={`/listings?status=${candidate}`}
            data-testid={`filter-${candidate}`}
            className={`rounded-full px-3 py-1 text-xs font-medium ${active === candidate ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600"}`}
          >
            {candidate}
          </Link>
        ))}
      </nav>

      {listings.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500" data-testid="listings-empty">
          No listings here yet — create one or run a bulk import.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="py-2">Title</th>
              <th className="py-2">Category</th>
              <th className="py-2">Status</th>
              <th className="py-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {listings.map((listing) => (
              <tr key={listing.id} className="border-t border-neutral-100" data-testid="listing-row">
                <td className="py-2">
                  <Link href={`/listings/${listing.id}`} className="font-medium text-neutral-900 hover:underline">
                    {listing.title}
                  </Link>
                </td>
                <td className="py-2 text-neutral-600">{listing.category.name}</td>
                <td className="py-2">
                  <StatusBadge status={listing.status} />
                </td>
                <td className="py-2 text-neutral-500">
                  {new Date(listing.updatedAt).toISOString().slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
