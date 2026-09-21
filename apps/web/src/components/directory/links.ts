/**
 * Pure href builders for the discovery surfaces — query params survive facet
 * and sort changes, and empty params never render as "?page=" noise.
 */
export interface CategoryQuery {
  page?: number;
  /** Exact supplier-type facet value. */
  type?: string | undefined;
  sort?: "tier" | "name" | undefined;
}

export function buildCategoryHref(slug: string, query: CategoryQuery = {}): string {
  const params = new URLSearchParams();
  if (query.page !== undefined && query.page > 1) params.set("page", String(query.page));
  if (query.type) params.set("type", query.type);
  if (query.sort === "name") params.set("sort", "name");
  const search = params.toString();
  return `/categories/${slug}${search ? `?${search}` : ""}`;
}
