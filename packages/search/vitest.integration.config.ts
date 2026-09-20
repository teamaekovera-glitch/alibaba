import { defineConfig } from "vitest/config";

// Runs against the pgvector service container in CI / local docker-compose.
// passWithNoTests until the search integration suites land (facets/semantic).
// The root beforeAll seeds the full deterministic corpus (1,200 listings) on a
// freshly migrated database, and the backfill test upserts ~1k embedding rows
// — both far exceed Vitest's 10s/5s defaults on CI runners.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    hookTimeout: 300_000,
    testTimeout: 300_000,
  },
});
