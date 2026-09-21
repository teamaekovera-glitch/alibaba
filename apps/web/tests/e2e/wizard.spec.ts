import { expect, test } from "@playwright/test";
import { PrismaClient } from "@packsource/db";

/**
 * The wizard happy path, zero API keys: a seeded supplier-ops user signs in
 * with a password, completes all six onboarding steps through the real UI
 * and server actions (mock storage + mock Stripe Connect), and reaches the
 * "submitted for review" state. Also asserts the resume behavior: a reload
 * mid-wizard lands on the same step, and a reload after submission shows
 * the locked submitted panel.
 */

// Wizard progress persists on the org, so reruns against a long-lived
// database (local dev, artifact caching) would resume past step one. Reset
// the e2e org's onboarding state before the run — CI's fresh seed makes this
// a no-op there.
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

test.beforeEach(async () => {
  await prisma.$transaction([
    prisma.plant.deleteMany({ where: { org: { slug: "e2e-supplier" } } }),
    prisma.capability.deleteMany({ where: { org: { slug: "e2e-supplier" } } }),
    prisma.equipment.deleteMany({ where: { org: { slug: "e2e-supplier" } } }),
    prisma.certification.deleteMany({ where: { org: { slug: "e2e-supplier" } } }),
    prisma.supplierProfile.deleteMany({ where: { org: { slug: "e2e-supplier" } } }),
  ]);
});

test("supplier completes onboarding and reaches submitted-for-review", async ({ page }) => {
  await page.goto("/sign-in");

  // Password tab is not the default — switch to it.
  await page.getByRole("button", { name: "Password" }).click();
  await page.getByTestId("password-email").fill("supplier-ops@e2e.packsource.test");
  await page.getByTestId("password-field").fill("e2e-password-123");
  await page.getByTestId("password-submit").click();
  await expect(page).toHaveURL("/");

  await page.goto("/onboarding");

  // Step 1: company details.
  await expect(page.getByTestId("step-company")).toBeVisible();
  await page.getByTestId("company-about").fill("Contract filler for beverages, 40k units/hour.");
  await page.getByTestId("submit-company").click();
  await expect(page.getByTestId("step-plants")).toBeVisible();

  // Resume check: reloading derives progress from the database, not session
  // state — the wizard must land back on the plants step.
  await page.reload();
  await expect(page.getByTestId("step-plants")).toBeVisible();

  // Step 2: plants.
  await page.getByTestId("plant-name").fill("Portland Plant");
  await page.getByTestId("plant-city").fill("Portland");
  await page.getByTestId("plant-country").fill("USA");
  await page.getByTestId("plant-primary").check();
  await page.getByTestId("submit-plant").click();
  await expect(page.getByTestId("step-certifications")).toBeVisible();

  // Step 3: certifications.
  await page.getByTestId("certification-type").fill("SQF");
  await page.getByTestId("certification-number").fill("SQF-2026-0042");
  await page.getByTestId("certification-expires").fill("2027-06-30");
  await page.getByTestId("submit-certification").click();
  await expect(page.getByTestId("step-equipment")).toBeVisible();

  // Step 4: equipment and capabilities.
  await page.getByTestId("equipment-kind").selectOption("FILLER");
  await page.getByTestId("equipment-make").fill("Krones");
  await page.getByTestId("submit-equipment").click();
  await page.getByTestId("capability-name").fill("Hot-fill");
  await page.getByTestId("submit-capability").click();
  await expect(page.getByTestId("step-terms")).toBeVisible();

  // Step 5: MOQ & payment terms.
  await page.getByTestId("terms-min-order").fill("5000");
  await page.getByTestId("terms-select").selectOption("NET_30");
  await page.getByTestId("submit-terms").click();
  await expect(page.getByTestId("step-payments")).toBeVisible();

  // Step 6: mock Stripe Connect link, then submit for review.
  await page.getByTestId("submit-payments").click();
  await expect(page.getByTestId("payments-linked")).toContainText("acct_mock_");
  await page.getByTestId("submit-for-review").click();
  await expect(page.getByTestId("wizard-submitted")).toBeVisible();

  // Post-submission reload: still submitted, still locked.
  await page.reload();
  await expect(page.getByTestId("wizard-submitted")).toBeVisible();
});
