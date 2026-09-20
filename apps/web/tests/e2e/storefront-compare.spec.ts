import { expect, test } from "@playwright/test";
import { OTHER_LISTING_SLUG, TARGET_LISTING_SLUG } from "./helpers";

/**
 * Buyer storefront over the deterministic seed: faceted browse, live query
 * narrowing, product detail economics (price/MOQ/lead, MOQ ladder,
 * attributes), and the four-item compare tray across two seeded listings
 * from different suppliers.
 */

test("search narrows seeded results and product pages render full economics", async ({ page }) => {
  await page.goto("/search");
  await expect(page.getByTestId("search-results")).toBeVisible();
  const browseCount = await page.getByTestId("result-count").textContent();

  await page.getByLabel("Search packaging listings").fill("pouch");
  // Debounced live query — wait for the narrowed result set.
  await expect
    .poll(async () => page.getByTestId("result-count").textContent(), { timeout: 20_000 })
    .not.toBe(browseCount);
  await expect(page.getByTestId("search-results").getByTestId("listing-result-card").first()).toBeVisible();

  // Open a product page straight from results.
  await page.getByTestId("search-results").getByTestId("listing-result-card").first().getByRole("link").first().click();
  await expect(page.getByTestId("product-title")).toBeVisible();
  await expect(page.getByTestId("price-from")).toContainText("$");
  await expect(page.getByTestId("moq-from")).toContainText("500");
  await expect(page.getByTestId("lead-time")).toContainText("days");
  await expect(page.getByTestId("moq-ladder")).toBeVisible();
  await expect(page.getByTestId("attribute-table")).toBeVisible();
  await expect(page.getByTestId("supplier-card")).toBeVisible();
});

test("compare tray collects products and renders the comparison table", async ({ page }) => {
  await page.goto(`/products/${TARGET_LISTING_SLUG}`);
  await expect(page.getByTestId("product-title")).toBeVisible();
  const firstTitle = (await page.getByTestId("product-title").textContent()) ?? "";
  await page.getByTestId("add-to-compare").click();
  // The tray lives in a cookie; the toggle reflects it via aria-pressed.
  await expect(page.getByTestId("add-to-compare")).toContainText("In compare");

  await page.goto(`/products/${OTHER_LISTING_SLUG}`);
  await expect(page.getByTestId("product-title")).toBeVisible();
  const secondTitle = (await page.getByTestId("product-title").textContent()) ?? "";
  await page.getByTestId("add-to-compare").click();
  await expect(page.getByTestId("add-to-compare")).toContainText("In compare");

  await page.goto("/compare");
  await expect(page.getByTestId("compare-table")).toBeVisible();
  // The table is transposed — one row per attribute, one column per product —
  // so assert on content (both product titles present) rather than row count.
  await expect(page.getByTestId("compare-table")).toContainText(firstTitle);
  await expect(page.getByTestId("compare-table")).toContainText(secondTitle);
  for (const cell of ["compare-price", "compare-moq", "compare-lead"]) {
    await expect(page.getByTestId("compare-table").getByTestId(cell).first()).toBeVisible();
  }
});
