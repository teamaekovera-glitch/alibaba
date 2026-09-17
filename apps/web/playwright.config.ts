import { defineConfig } from "@playwright/test";
import path from "node:path";

/**
 * Minimal Playwright setup for the supplier-onboarding wizard e2e test.
 * Zero API keys: AUTH_SECRET gets a deterministic test value, mail is the
 * mock adapter, payments/storage mocks are wired in apps/web.
 *
 * Requires DATABASE_URL pointing at a disposable Postgres with pgvector
 * (CI's pgvector job provides one; locally: docker compose up -d db).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  globalSetup: path.join(__dirname, "tests/e2e/global-setup.ts"),
  webServer: {
    command: "pnpm dev --port 3100",
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      AUTH_SECRET: "e2e-test-secret-not-for-production",
      NODE_ENV: "development",
    },
  },
});
