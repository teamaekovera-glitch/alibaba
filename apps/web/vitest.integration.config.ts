import path from "node:path";
import { defineConfig } from "vitest/config";

// Runs against the pgvector service container in CI / local docker-compose.
// passWithNoTests until the integration suites land.
export default defineConfig({
  resolve: {
    // Mirror the app's tsconfig paths so tests import app code as `@/...`.
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // Next app code uses the automatic JSX runtime; vitest's esbuild transform
  // must match or server components fail with "React is not defined".
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
  },
});
