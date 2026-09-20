import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    // All suites share one pgvector service; serialize files so a suite's
    // migrate/truncate setup cannot race another suite's assertions
    // (same contract as the db package's integration config).
    fileParallelism: false,
  },
});
