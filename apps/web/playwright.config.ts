import { defineConfig } from "@playwright/test";
import path from "node:path";

/**
 * E2E configuration.
 *
 * Local (default): the suite boots the dev server — the only mode where the
 * dev-inbox magic-link flow exists (production hard-404s /api/dev/inbox by
 * design).
 *
 * CI (E2E_PRODUCTION_SERVER=1): the job has already built the app, so the
 * suite boots the production build (`next start`) and tests the real
 * artifact; the dev-inbox-only test skips itself.
 *
 * Zero API keys: adapters stay on their deterministic mocks (MOCK=true).
 * Single worker, zero retries — determinism over convenience.
 */
const productionServer = process.env.E2E_PRODUCTION_SERVER === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { outputFolder: "../../playwright-report", open: "never" }]] : "list",
  use: {
    // All browser traffic uses localhost — Auth.js normalizes its sign-in
    // redirect to the localhost origin, and 127.0.0.1 is a different cookie
    // origin, so the session would never stick if the two were mixed.
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  expect: {
    timeout: 20_000,
  },
  globalSetup: path.join(__dirname, "tests/e2e/global-setup.ts"),
  webServer: {
    command: productionServer ? "pnpm start --port 3100" : "pnpm dev --port 3100",
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      AUTH_SECRET: "e2e-test-secret-not-for-production",
      MOCK: "true",
      // Only pin NODE_ENV for the dev server; `next start` sets production itself.
      ...(productionServer ? {} : { NODE_ENV: "development" }),
    },
  },
});
