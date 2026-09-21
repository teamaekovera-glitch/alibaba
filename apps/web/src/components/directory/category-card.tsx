import Link from "next/link";

/**
 * The Amazon/Flipkart-style category card that opens the home page: artwork,
 * a one-line description, and the live count of Platform Ready suppliers
 * whose primary category matches. Counts come from categoryCounts() at
 * request time so a card can never disagree with the rows its category page
 * renders.
 */
export interface CategoryCardProps {
  category: {
    slug: string;
    name: string;
    description: string;
    /** Committed artwork path, e.g. "/discovery/dairy.jpg". */
    image: string;
  };
  /** Live primary-assignment count from categoryCounts(). */
  count: number;
}

/** Formats the supplier count, e.g. 918 → "918 suppliers", 0 → "Coming soon". */
export function categoryCountLabel(count: number): string {
  return count === 1 ? "1 supplier" : count > 1 ? `${count.toLocaleString("en-US")} suppliers` : "Coming soon";
}

export function CategoryCard({ category, count }: CategoryCardProps) {
  return (
    <Link
      href={`/categories/${category.slug}`}
      className="group flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white transition-colors hover:border-brand-300"
      data-testid={`category-card-${category.slug}`}
    >
      <div className="aspect-[16/9] overflow-hidden bg-neutral-100">
        {/* Committed artwork — static public asset, no runtime fetch. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={category.image}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
        />
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-3">
        <h3 className="font-medium text-neutral-900">{category.name}</h3>
        <p className="text-xs text-neutral-500">{category.description}</p>
        <p className="mt-auto pt-2 text-xs font-medium text-brand-700" data-testid="category-count">
          {categoryCountLabel(count)}
        </p>
      </div>
    </Link>
  );
}
