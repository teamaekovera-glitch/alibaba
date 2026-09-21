import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDiscoveryCategory, listByCategory } from "@packsource/db";
import { db } from "@/lib/db";

import { pageMetadata } from "@/lib/seo";
import { SupplierCard } from "@/components/directory/supplier-card";
import { categoryTint } from "@/components/directory/visuals";
import { Pagination } from "@/components/directory/pagination";
import { buildCategoryHref } from "@/components/directory/links";

/**
 * The supplier grid for one discovery category (spec: the Amazon/Flipkart
 * grid) — server-rendered reads over the PlatformSupplier directory via
 * listByCategory: 24 per page, tier-then-name sort, supplier-type facet
 * chips with counts, and a recovery state for unpopulated categories. Public
 * and read-only; no auth, no actions.
 */
export const dynamic = "force-dynamic";

type CategoryPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; type?: string; sort?: string }>;
};

async function loadPage(props: CategoryPageProps) {
  const { slug } = await props.params;
  const searchParams = await props.searchParams;
  const category = getDiscoveryCategory(slug);
  if (!category) return null;

  const page = Math.max(1, Number.parseInt(searchParams.page ?? "1", 10) || 1);
  const sort = searchParams.sort === "name" ? ("name" as const) : ("tier" as const);
  const listing = await listByCategory(db, {
    slug,
    page,
    supplierType: searchParams.type,
    sort,
  });
  return { category, page, sort, activeType: searchParams.type, listing };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const category = getDiscoveryCategory(slug);
  if (!category) return pageMetadata({
    title: "Category not found — PackSource",
    description: "This supplier category does not exist.",
    path: `/categories/${slug}`,
    noIndex: true,
  });
  return pageMetadata({
    title: `${category.name} suppliers — PackSource`,
    description: `${category.description}. Browse Platform Ready suppliers in ${category.name.toLowerCase()} on PackSource.`,
    path: `/categories/${category.slug}`,
  });
}

export default async function CategoryPage(props: CategoryPageProps) {
  const data = await loadPage(props);
  if (!data) notFound();
  const { category, page, sort, activeType, listing } = data;
  const { items, total, facetTypes } = listing;
  const totalPages = Math.max(1, Math.ceil(total / 24));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <header className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <div className="aspect-[21/4] w-full overflow-hidden bg-neutral-100">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={category.image} alt="" className="h-full w-full object-cover" />
        </div>
        <div className="p-5">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{category.name}</h1>
          <p className="mt-1 text-neutral-500">{category.description}</p>
          <p className="mt-2 text-sm font-medium text-brand-700" data-testid="category-total">
            {total.toLocaleString("en-US")} {total === 1 ? "supplier" : "suppliers"}
          </p>
        </div>
      </header>

      <nav className="mt-5 flex flex-wrap items-center gap-2" data-testid="facet-row" aria-label="Supplier type filters">
        <Link
          href={buildCategoryHref(category.slug, { sort })}
          className={`rounded-full border px-3 py-1 text-sm ${
            activeType === undefined
              ? "border-brand-600 bg-brand-600 text-white"
              : "border-neutral-200 bg-white text-neutral-700 hover:border-brand-300"
          }`}
        >
          All ({total.toLocaleString("en-US")})
        </Link>
        {facetTypes.map((facet) => (
          <Link
            key={facet.type}
            href={buildCategoryHref(category.slug, { type: facet.type, sort })}
            className={`rounded-full border px-3 py-1 text-sm ${
              activeType === facet.type
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-neutral-200 bg-white text-neutral-700 hover:border-brand-300"
            }`}
          >
            {facet.type} ({facet.n.toLocaleString("en-US")})
          </Link>
        ))}
      </nav>

      <div className="mt-3 flex items-center justify-between text-sm text-neutral-500">
        <span data-testid="sort-indicator">Sorted by {sort === "name" ? "name" : "verification tier"}</span>
        <span className="flex gap-2">
          <Link
            href={buildCategoryHref(category.slug, { type: activeType, sort: "tier" })}
            className={sort === "tier" ? "font-medium text-brand-700" : "hover:underline"}
          >
            Tier
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={buildCategoryHref(category.slug, { type: activeType, sort: "name" })}
            className={sort === "name" ? "font-medium text-brand-700" : "hover:underline"}
          >
            Name
          </Link>
        </span>
      </div>

      {total === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-10 text-center" data-testid="empty-category">
          <h2 className="font-medium text-neutral-900">No suppliers here yet</h2>
          <p className="mt-1 text-sm text-neutral-500">
            The import found no records matching this category{activeType ? " and type filter" : ""}.
          </p>
          <Link href="/" className="mt-4 inline-block text-sm text-brand-700 hover:underline">
            ← Back to all categories
          </Link>
        </div>
      ) : (
        <>
          <ul className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="supplier-grid">
            {items.map((supplier) => (
              <li key={supplier.id}>
                <SupplierCard supplier={supplier} categoryTint={categoryTint(supplier.primaryCategory)} />
              </li>
            ))}
          </ul>
          <p className="mt-4 text-center text-xs text-neutral-500" data-testid="grid-range">
            {(page - 1) * 24 + 1}–{Math.min(page * 24, total)} of {total.toLocaleString("en-US")} shown
          </p>
          <Pagination
            page={page}
            totalPages={totalPages}
            hrefFor={(target) => buildCategoryHref(category.slug, { page: target, type: activeType, sort })}
          />
        </>
      )}
    </div>
  );
}
