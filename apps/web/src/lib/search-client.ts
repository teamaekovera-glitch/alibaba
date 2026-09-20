import type { FacetCounts, ListingSearchDocument, SearchResultSource } from "@packsource/search";

/**
 * Client-side search contract for the storefront: a single normalized result
 * shape for the three discovery payloads (keyword, hybrid, visual), the facet
 * sidebar's group metadata, and pure URL-param builders. Pure and unit-tested;
 * the fetch layer stays dumb.
 */

export interface StorefrontResult {
  document: ListingSearchDocument;
  /** 0..1 combined relevance (keyword/hybrid paths). */
  score?: number;
  /** 0..1 cosine similarity (visual path only). */
  similarity?: number;
}

export interface NormalizedSearch {
  ok: true;
  results: StorefrontResult[];
  total: number;
  facetCounts: FacetCounts;
  source: SearchResultSource;
  degraded: boolean;
}

export interface NormalizedSearchError {
  ok: false;
  error: string;
}

/** True when the payload is a success-shaped search response. */
function isSearchPayload(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !("error" in payload);
}

/**
 * Normalize any discovery API payload into card-renderable results. Keyword
 * responses carry hits/total/facetCounts; hybrid and visual responses carry
 * hydrated documents on each result. Keyword-path degraded sources (Postgres
 * outage fallback) set `degraded` so the UI can badge it (PR #7 behavior).
 */
export function normalizeSearchPayload(payload: unknown): NormalizedSearch | NormalizedSearchError {
  if (!isSearchPayload(payload)) {
    return { ok: false, error: "unexpected search response" };
  }

  if (payload.mode === "hybrid" || payload.mode === "visual") {
    const raw = Array.isArray(payload.results) ? payload.results : [];
    const results: StorefrontResult[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as { document?: unknown; score?: unknown; similarity?: unknown };
      if (typeof entry.document !== "object" || entry.document === null) continue;
      results.push({
        document: entry.document as ListingSearchDocument,
        score: typeof entry.score === "number" ? entry.score : undefined,
        similarity: typeof entry.similarity === "number" ? entry.similarity : undefined,
      });
    }
    return {
      ok: true,
      results,
      total: results.length,
      facetCounts: {},
      source: "search-index",
      degraded: false,
    };
  }

  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  const results: StorefrontResult[] = [];
  for (const hit of hits) {
    if (typeof hit !== "object" || hit === null) continue;
    const entry = hit as { document?: unknown; score?: unknown };
    if (typeof entry.document !== "object" || entry.document === null) continue;
    results.push({
      document: entry.document as ListingSearchDocument,
      score: typeof entry.score === "number" ? entry.score : undefined,
    });
  }
  const source = payload.source === "postgres-fallback" ? "postgres-fallback" : "search-index";
  return {
    ok: true,
    results,
    total: typeof payload.total === "number" ? payload.total : results.length,
    facetCounts:
      typeof payload.facetCounts === "object" && payload.facetCounts !== null
        ? (payload.facetCounts as FacetCounts)
        : {},
    source,
    degraded: source === "postgres-fallback",
  };
}

/** Sidebar groups in display order, with human labels. The facet set the engine counts. */
export const FACET_GROUPS: { field: string; label: string }[] = [
  { field: "categoryFamily", label: "Category" },
  { field: "format", label: "Format" },
  { field: "material", label: "Material" },
  { field: "sizeBand", label: "Size" },
  { field: "moqBand", label: "MOQ" },
  { field: "priceBand", label: "Unit price" },
  { field: "leadTimeBand", label: "Lead time" },
  { field: "city", label: "City" },
  { field: "country", label: "Country" },
  { field: "certifications", label: "Certifications" },
  { field: "sustainability", label: "Sustainability" },
  { field: "printMethods", label: "Print methods" },
];

/** Verification tier is filterable but not facet-counted; rendered statically. */
export const VERIFICATION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "AEKOVERA_VETTED", label: "Aekovera-vetted" },
  { value: "VERIFIED", label: "Verified" },
  { value: "UNVERIFIED", label: "Unverified" },
];

export const SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "lead-time-asc", label: "Fastest lead time" },
] as const;

/** How many values to show per facet group before truncating. */
export const FACET_VALUES_SHOWN = 8;

/** Per-page size for the results grid (API clamps to 50). */
export const SEARCH_PAGE_SIZE = 20;

/**
 * Replace one multi-valued facet param in a URLSearchParams copy. Toggling a
 * value on rewrites the page-1 offset (page numbers never survive a filter
 * change) and clears itself on an empty selection.
 */
export function withFacetParam(
  params: URLSearchParams,
  field: string,
  value: string,
  enabled: boolean,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const current = (next.get(field) ?? "").split(",").filter(Boolean);
  const updated = enabled
    ? [...new Set([...current, value])]
    : current.filter((entry) => entry !== value);
  if (updated.length > 0) {
    next.set(field, updated.join(","));
  } else {
    next.delete(field);
  }
  next.delete("offset");
  return next;
}

/** Parse the comma-joined multi-value facet param for checkbox state. */
export function facetParamValues(params: URLSearchParams, field: string): string[] {
  return (params.get(field) ?? "").split(",").filter(Boolean);
}
