import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    // Suites share one Postgres database and truncate it in beforeAll —
    // run test files sequentially (same pattern as packages/db).
    fileParallelism: false,
  },
});
