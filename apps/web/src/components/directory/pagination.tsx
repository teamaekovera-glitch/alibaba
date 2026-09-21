import Link from "next/link";

/**
 * Server-rendered pagination for the category grid: prev/next arrows plus a
 * bounded page window (first, last, and the pages around the current one).
 * Pure and presentational — hrefs are prebuilt by the caller so query params
 * (facet, sort) survive page changes.
 */
export interface PaginationProps {
  page: number;
  totalPages: number;
  /** Builds the href for a page number, preserving facet/sort params. */
  hrefFor: (page: number) => string;
}

export interface PaginationItem {
  key: string;
  label: string;
  kind: "current" | "page" | "ellipsis" | "prev" | "next";
  page?: number;
}

/** Bounded window: 1 … c-1 c c+1 … N (elided when the range is small). */
export function pageWindow(page: number, totalPages: number): PaginationItem[] {
  const items: PaginationItem[] = [];
  const push = (kind: PaginationItem["kind"], label: string, pageNum?: number, key?: string) =>
    items.push({ kind, label, page: pageNum, key: key ?? `${kind}-${label}` });

  if (totalPages <= 1) return items;

  const window = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...window].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let previous = 0;
  for (const p of sorted) {
    if (p - previous > 1) push("ellipsis", "…", undefined, `ellipsis-${p}`);
    push(p === page ? "current" : "page", String(p), p);
    previous = p;
  }

  if (page > 1) push("prev", "← Prev", page - 1, "prev");
  if (page < totalPages) push("next", "Next →", page + 1, "next");
  return items;
}

export function Pagination({ page, totalPages, hrefFor }: PaginationProps) {
  if (totalPages <= 1) return null;
  return (
    <nav className="flex flex-wrap items-center justify-center gap-1 py-6" data-testid="pagination" aria-label="Pagination">
      {pageWindow(page, totalPages).map((item) => {
        if (item.kind === "ellipsis") {
          return (
            <span key={item.key} className="px-2 text-sm text-neutral-400">
              …
            </span>
          );
        }
        if (item.kind === "current") {
          return (
            <span
              key={item.key}
              aria-current="page"
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.key}
            href={item.page !== undefined ? hrefFor(item.page) : "#"}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 hover:border-brand-300 hover:bg-brand-50"
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
