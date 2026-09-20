import { expect, test } from "@playwright/test";
import { SALES_EMAIL, signInWithPassword } from "./helpers";

/**
 * Supplier listing lifecycle over the merged listings console: create a
 * draft, upload a spec sheet through the deterministic mock extraction
 * adapter, apply and human-confirm the suggestions, then submit the listing
 * for review (DRAFT → PENDING_REVIEW). Zero API keys — the vision/LLM
 * adapters are the deterministic mocks wired by the mock-first rule.
 */

const LISTING_TITLE = "E2E Listing — 16 oz PET Jar";
const SPEC_SHEET = [
  "Material: PET (recycled content 30%)",
  "Capacity: 473 ml",
  "Neck finish: 38mm",
  "Maximum decoration: 6 colors, digital printing",
  "Food contact: food grade",
  "Recyclability: widely recyclable",
].join("\n");

test("supplier creates a listing, extracts spec, confirms, and submits for review", async ({ page }) => {
  await signInWithPassword(page, SALES_EMAIL);

  // Seeded workflow rows are present in the console (deterministic seed).
  await page.goto("/listings");
  await expect(page.getByTestId("new-listing")).toBeVisible();
  await expect(page.getByTestId("listing-row").first()).toBeVisible();

  // ── Create the draft ───────────────────────────────────────────────────────
  await page.getByTestId("new-listing").click();
  await page.getByTestId("listing-title").fill(LISTING_TITLE);
  // Rigid's required attributes — validated server-side on create.
  await page.locator('select[name="attr_material"]').selectOption({ label: "PET" });
  await page.locator('input[name="attr_dimensions_l"]').fill("95");
  await page.locator('input[name="attr_dimensions_w"]').fill("50");
  await page.locator('input[name="attr_dimensions_h"]').fill("180");
  await page.locator('input[name="attr_volumeMl"]').fill("473");
  await page.locator('select[name="attr_foodContact"]').selectOption({ label: "FOOD_GRADE" });
  await page.locator('input[name="moq_minQty_1"]').fill("500");
  await page.locator('input[name="moq_price_1"]').fill("38");
  await page.locator('input[name="lead_min_1"]').fill("500");
  await page.locator('input[name="lead_days_1"]').fill("12");
  await page.getByTestId("listing-create-submit").click();
  await expect(page.getByTestId("form-ok")).toContainText(LISTING_TITLE);

  // ── Open the editor from the console ───────────────────────────────────────
  await page.goto("/listings");
  await page.getByTestId("listing-row").filter({ hasText: LISTING_TITLE }).getByRole("link").click();
  // The editor page renders the save form and the spec-sheet panel.
  await expect(page.getByTestId("listing-save")).toBeVisible();

  // ── Upload spec sheet → deterministic mock extraction ─────────────────────
  await page.getByTestId("spec-sheet-input").setInputFiles({
    name: "e2e-pet-jar-spec.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(SPEC_SHEET, "utf-8"),
  });
  await page.getByTestId("spec-sheet-upload").click();
  // The sheet card's test id is derived from its extraction status.
  await expect(page.getByTestId("spec-sheet-EXTRACTED")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("spec-apply").click();
  await page.getByTestId("spec-confirm").click();
  await expect(page.getByTestId("spec-sheet-CONFIRMED")).toBeVisible();

  // ── Submit for review: DRAFT → PENDING_REVIEW ─────────────────────────────
  await page.getByTestId("transition-submit").click();
  // The transition bar re-renders with supplier-visible actions for
  // PENDING_REVIEW (withdraw) — submit is gone.
  await expect(page.getByTestId("transition-withdraw")).toBeVisible();
  await expect(page.getByTestId("transition-submit")).toBeHidden();
});
