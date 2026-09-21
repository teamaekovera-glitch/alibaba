import { expect, test } from "@playwright/test";
import { BUYER_EMAIL, signInWithPassword } from "./helpers";

/**
 * Auth coverage on top of the onboarding wizard spec: password sign-in for a
 * seeded-role account, magic-link sign-in through the dev-only mock inbox
 * (zero API keys — the outbox endpoint is a non-production route by design),
 * and the unauthenticated redirect into the app shell.
 *
 * The root nav is a static server component with a constant "Sign in" link
 * (apps/web/src/app/layout.tsx has no session-aware chrome), so "signed in"
 * is proven the way the app actually behaves: protected surfaces render
 * instead of redirecting to /sign-in.
 */

test("password sign-in reaches the signed-in shell", async ({ page }) => {
  await signInWithPassword(page, BUYER_EMAIL);
  // A buyer org owner's protected surface renders — the session stuck.
  await page.goto("/rfq");
  await expect(page).toHaveURL(/\/rfq$/);
  await expect(page.getByTestId("rfq-dashboard-title")).toBeVisible();
});

test("magic link from the mock inbox signs a user in", async ({ page, request }) => {
  // Dev-only: the outbox endpoint hard-404s in production builds by design,
  // so CI's production-server run skips this test (it still runs locally).
  test.skip(process.env.E2E_PRODUCTION_SERVER === "1", "dev-inbox magic-link flow is a non-production route");

  await page.goto("/sign-in");
  await page.getByTestId("magic-email").fill(BUYER_EMAIL);
  await page.getByTestId("magic-submit").click();
  await expect(page.getByTestId("magic-submit")).toContainText("Link sent");

  const inbox = await request.get("/api/dev/inbox");
  expect(inbox.ok()).toBeTruthy();
  const inboxBody = (await inbox.json()) as { outbox?: { to?: string; html?: string }[] };
  // The outbox accumulates across the dev server's life — take the newest
  // message addressed to this recipient so the token is not an expired one.
  const messages = (inboxBody.outbox ?? []).filter((message) => message.to === BUYER_EMAIL);
  expect(messages.length, "at least one magic-link email should be in the outbox").toBeGreaterThan(0);
  const html = messages[messages.length - 1]?.html ?? "";
  const magicUrl = /https?:\/\/[^\s"]+\/api\/auth\/magic-callback\?token=[^\s"]+/.exec(html)?.[0];
  expect(magicUrl, "magic link should be in the mock outbox").toBeTruthy();

  await page.goto(magicUrl!);
  await page.waitForURL((url) => url.pathname === "/");
  await page.goto("/rfq");
  await expect(page).toHaveURL(/\/rfq$/);
  await expect(page.getByTestId("rfq-dashboard-title")).toBeVisible();
});

test("unauthenticated visits to protected surfaces land on sign-in", async ({ page }) => {
  await page.goto("/rfq");
  await expect(page).toHaveURL(/sign-in/);
  await page.goto("/orders");
  await expect(page).toHaveURL(/sign-in/);
  await page.goto("/listings");
  await expect(page).toHaveURL(/sign-in/);
});

test("wrong password is rejected and no session is minted", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Password" }).click();
  await page.getByTestId("password-email").fill(BUYER_EMAIL);
  await page.getByTestId("password-field").fill("definitely-not-the-password");
  await page.getByTestId("password-submit").click();
  await page.goto("/rfq");
  await expect(page).toHaveURL(/sign-in/);
});
