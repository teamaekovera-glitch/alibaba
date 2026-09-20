"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import type { FacetCounts } from "@packsource/search";
import { DemoDataBanner } from "@packsource/ui";
import {
  FACET_GROUPS,
  FACET_VALUES_SHOWN,
  SEARCH_PAGE_SIZE,
  SORT_OPTIONS,
  VERIFICATION_FILTER_OPTIONS,
  facetParamValues,
  normalizeSearchPayload,
  withFacetParam,
  type NormalizedSearch,
} from "@/lib/search-client";
import { ListingResultCard } from "./listing-result-card";

/**
 * The results experience shared by text, hybrid, and visual discovery (spec:
 * visual results land in the normal search UI). Server-driven state: filters,
 * sort, and pagination live in the URL; this component mirrors them into
 * /api/search calls and re-renders. The off-happy-path states (loading, empty,
 * degraded, error) render inline below.
 */

const BASE_URL = "/api/search";

/** Convert the current URL params into the discovery API query. */
function apiParamsFrom(search: URLSearchParams, offset: number): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of search.entries()) {
    if (key === "offset") continue;
    params.append(key, value);
  }
  if (search.get("q") && !params.has("mode")) {
    // Free-text queries lean on the engine's typo tolerance and relevance
    // ranking; a query-less browse is a pure filter search.
    params.set("mode", "hybrid");
  }
  params.set("limit", String(SEARCH_PAGE_SIZE));
  params.set("offset", String(offset));
  return params;
}

export function SearchExperience() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [queryInput, setQueryInput] = useState(searchParams.get("q") ?? "");
  const [search, setSearch] = useState<NormalizedSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [reloadKey, setReloadKey] = useState(0);
  // Typo tolerance lives server-side; the deferred value keeps typing smooth
  // while stale queries drain.
  const deferredQuery = useDeferredValue(queryInput);

  const offset = Number.parseInt(searchParams.get("offset") ?? "0", 10) || 0;
  const activeQuery = searchParams.get("q") ?? "";

  const runSearch = useCallback(async (params: URLSearchParams) => {
    setError(null);
    try {
      const response = await fetch(`${BASE_URL}?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) {
        // Structured API errors (validation 4xx, outage 503).
        const message =
          typeof payload === "object" && payload !== null && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `Search failed (${response.status}).`;
        setError(message);
        setSearch(null);
        return;
      }
      const normalized = normalizeSearchPayload(payload);
      if (normalized.ok) {
        setSearch(normalized);
      } else {
        setError(normalized.error);
        setSearch(null);
      }
    } catch {
      setError("Search is unreachable right now. Check your connection and try again.");
      setSearch(null);
    }
  }, []);

  // Re-run discovery whenever the URL state changes (facets, sort, page, query).
  useEffect(() => {
    void runSearch(apiParamsFrom(searchParams, offset));
  }, [searchParams, offset, reloadKey, runSearch]);

  const pushQueryState = useCallback(
    (mutate: (params: URLSearchParams) => void, replace: boolean) => {
      const params = new URLSearchParams(searchParams);
      mutate(params);
      params.delete("offset");
      const next = `/search?${params.toString()}`;
      startTransition(() => {
        if (replace) {
          router.replace(next);
        } else {
          router.push(next);
        }
      });
    },
    [router, searchParams],
  );

  // Explicit submit — pushes a history entry.
  const submitQuery = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const value = queryInput.trim();
      pushQueryState((params) => {
        if (value) {
          params.set("q", value);
        } else {
          params.delete("q");
          params.delete("mode");
        }
      }, false);
    },
    [pushQueryState, queryInput],
  );

  // Debounced live query — keeps the box responsive without a submit click.
  useEffect(() => {
    if (deferredQuery === activeQuery) return;
    const handle = setTimeout(() => {
      pushQueryState((params) => {
        if (deferredQuery.trim()) {
          params.set("q", deferredQuery.trim());
        } else {
          params.delete("q");
          params.delete("mode");
        }
      }, true);
    }, 350);
    return () => clearTimeout(handle);
  }, [deferredQuery, activeQuery, pushQueryState]);

  const toggleFacet = useCallback(
    (field: string, value: string, enabled: boolean) => {
      const params = withFacetParam(searchParams, field, value, enabled);
      startTransition(() => {
        router.push(`/search?${params.toString()}`);
      });
    },
    [router, searchParams],
  );

  const setSort = useCallback(
    (value: string) => {
      pushQueryState((params) => {
        if (value === "relevance") {
          params.delete("sort");
        } else {
          params.set("sort", value);
        }
      }, false);
    },
    [pushQueryState],
  );

  const setPage = useCallback(
    (nextOffset: number) => {
      pushQueryState((params) => {
        params.set("offset", String(nextOffset));
      }, false);
    },
    [pushQueryState],
  );

  const facetCounts = useMemo(() => search?.facetCounts ?? {}, [search]);
  const activeFilters = useMemo(
    () =>
      FACET_GROUPS.flatMap(({ field }) =>
        facetParamValues(searchParams, field).map((value) => ({ field, value })),
      ),
    [searchParams],
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8" data-testid="search-experience">
      <DemoDataBanner />

      <form onSubmit={submitQuery} className="flex gap-2" data-testid="search-form">
        <input
          type="search"
          name="q"
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          placeholder="Search packaging — try “32 oz PET bottle” or a typo like “bttle”"
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

      <div className="mt-3 flex items-center justify-between text-sm">
        <Link href="/search/visual" className="text-brand-700 hover:underline" data-testid="visual-search-link">
          Search by image →
        </Link>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">Sort</span>
          <select
            value={searchParams.get("sort") ?? "relevance"}
            onChange={(event) => setSort(event.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
            data-testid="sort-select"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {activeFilters.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="active-filters">
          {activeFilters.map(({ field, value }) => (
            <button
              key={`${field}-${value}`}
              type="button"
              onClick={() => toggleFacet(field, value, false)}
              className="rounded-full border border-neutral-300 px-3 py-0.5 text-xs hover:bg-neutral-50"
              data-testid={`active-filter-${field}-${value}`}
            >
              {value} ×
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-6 flex gap-6">
        <FacetSidebar facetCounts={facetCounts} searchParams={searchParams} onToggle={toggleFacet} />

        <section className="min-w-0 flex-1" aria-live="polite" aria-busy={isPending}>
          {error ? (
            <ErrorState message={error} onRetry={() => setReloadKey((key) => key + 1)} />
          ) : !search ? (
            <LoadingState />
          ) : null}

          {search?.degraded ? (
            <div
              className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
              data-testid="degraded-search-banner"
            >
              The primary search index is unavailable — results are served from our database
              fallback and may be missing the newest listings or typo tolerance.
            </div>
          ) : null}

          {search && search.results.length === 0 ? (
            <EmptyState query={activeQuery} />
          ) : null}

          {search && search.results.length > 0 ? (
            <>
              <p className="mb-3 text-sm text-neutral-500" data-testid="result-count">
                {search.total} listing{search.total === 1 ? "" : "s"}
              </p>
              <div className="flex flex-col gap-3" data-testid="search-results">
                {search.results.map((result) => (
                  <ListingResultCard key={result.document.id} result={result} />
                ))}
              </div>
              <Pagination
                offset={offset}
                total={search.total}
                pageSize={SEARCH_PAGE_SIZE}
                onPage={setPage}
              />
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function FacetSidebar({
  facetCounts,
  searchParams,
  onToggle,
}: {
  facetCounts: FacetCounts;
  searchParams: URLSearchParams;
  onToggle: (field: string, value: string, enabled: boolean) => void;
}) {
  return (
    <aside className="w-56 flex-none" data-testid="facet-sidebar">
      <div className="mb-4" data-testid="facet-group-verificationTier">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Verification
        </h3>
        {VERIFICATION_FILTER_OPTIONS.map((option) => {
          const checked = facetParamValues(searchParams, "verificationTier").includes(option.value);
          return (
            <label key={option.value} className="flex items-center gap-2 py-0.5 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onToggle("verificationTier", option.value, event.target.checked)}
                data-testid={`facet-verificationTier-${option.value}`}
              />
              {option.label}
            </label>
          );
        })}
      </div>

      {FACET_GROUPS.map(({ field, label }) => {
        const counts = facetCounts[field];
        if (!counts || Object.keys(counts).length === 0) {
          return null;
        }
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const selected = facetParamValues(searchParams, field);
        return (
          <div key={field} className="mb-4" data-testid={`facet-group-${field}`}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {label}
            </h3>
            {entries.slice(0, FACET_VALUES_SHOWN).map(([value, count]) => (
              <label key={value} className="flex items-center gap-2 py-0.5 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(value)}
                  onChange={(event) => onToggle(field, value, event.target.checked)}
                  data-testid={`facet-${field}-${value}`}
                />
                <span className="min-w-0 truncate">{value}</span>
                <span className="ml-auto text-xs text-neutral-400">{count}</span>
              </label>
            ))}
          </div>
        );
      })}
    </aside>
  );
}

function Pagination({
  offset,
  total,
  pageSize,
  onPage,
}: {
  offset: number;
  total: number;
  pageSize: number;
  onPage: (nextOffset: number) => void;
}) {
  if (total <= pageSize) return null;
  const page = Math.floor(offset / pageSize) + 1;
  const pageCount = Math.ceil(total / pageSize);
  return (
    <nav className="mt-6 flex items-center justify-center gap-4 text-sm" data-testid="pagination">
      <button
        type="button"
        disabled={offset === 0}
        onClick={() => onPage(Math.max(0, offset - pageSize))}
        className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40"
      >
        ← Previous
      </button>
      <span className="text-neutral-500">
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        disabled={offset + pageSize >= total}
        onClick={() => onPage(offset + pageSize)}
        className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40"
      >
        Next →
      </button>
    </nav>
  );
}

export function EmptyState({ query }: { query: string }) {
  return (
    <div
      className="rounded-lg border border-neutral-200 bg-white p-8 text-center"
      data-testid="search-empty-state"
    >
      <h2 className="font-medium text-neutral-900">No matching listings</h2>
      <p className="mt-1 text-sm text-neutral-500">
        {query
          ? `Nothing matched “${query}”. Try fewer words, or check for typos — search tolerates them.`
          : "No listings match the selected filters. Remove a filter to widen the search."}
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" data-testid="search-loading-state">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-28 animate-pulse rounded-lg border border-neutral-100 bg-neutral-50"
        />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="rounded-lg border border-red-200 bg-red-50 p-6 text-center"
      data-testid="search-error-state"
    >
      <h2 className="font-medium text-red-900">Search is temporarily unavailable</h2>
      <p className="mt-1 text-sm text-red-700">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
      >
        Retry
      </button>
    </div>
  );
}
