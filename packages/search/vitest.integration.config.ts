import { defineConfig } from "vitest/config";

// Runs against the pgvector service container in CI / local docker-compose.
// passWithNoTests until the search integration suites land (facets/semantic).
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
  },
});
