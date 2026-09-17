import { defineConfig } from "vitest/config";

// Runs against the pgvector service container in CI / local docker-compose.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    // All suites share one pgvector service; serialize files so a suite's
    // migrate/truncate setup cannot race another suite's assertions.
    fileParallelism: false,
  },
});
