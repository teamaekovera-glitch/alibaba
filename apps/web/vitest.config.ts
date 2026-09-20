import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror the app's tsconfig paths so tests import app code as `@/...`.
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // Next app code uses the automatic JSX runtime; vitest's esbuild transform
  // must match or server components fail with "React is not defined".
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
