"use client";

/**
 * Route-level error boundary for /search: unexpected rendering failures show
 * a structured fallback instead of the framework's production crash screen.
 * Structured API outages are handled inside SearchExperience with a retry;
 * this catches everything outside that contract.
 */
export default function SearchError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16" data-testid="search-route-error">
      <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center">
        <h1 className="font-medium text-red-900">Something went wrong with search</h1>
        <p className="mt-1 text-sm text-red-700">
          The discovery service hit an unexpected error. You can retry or browse from the homepage.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
