import { defineConfig } from "vitest/config";

// Runs against the pgvector service container in CI / local docker-compose.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
  },
});
