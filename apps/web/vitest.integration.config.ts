import { defineConfig } from "vitest/config";

// Integration suites land with later workstreams; the CI integration job runs
// this config against the pgvector service container.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
  },
});
