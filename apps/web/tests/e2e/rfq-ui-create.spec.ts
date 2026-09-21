import { expect, test } from "@playwright/test";
import { BUYER_EMAIL, TARGET_LISTING_ID, TARGET_LISTING_SLUG, listingCategoryFor, signInWithPassword } from "./helpers";

/**
 * The repaired UI create+send leg — the flow PR #16's QA pass found broken
 * (no category selector meant UI-created RFQs could never be sent). Three
 * tests, each a complete user story against the deterministic seed:
 *
 *   1. Broadcast: buyer picks a category on /rfq, the draft page shows the
 *      matcher's supplier matches (proof the category reached the matcher),
 *      then send succeeds.
 *   2. Single-listing: "Request a quote" on a product page deep-links into
 *      /rfq?listing=..., the form inherits the listing's category, the
 *      draft matches the listing's supplier, send succeeds.
 *   3. Validation: submitting a broadcast without a category renders the
 *      form error and never leaves the dashboard.
 *
 * Zero API keys — sessions come from the password provider against users
 * seeded by global-setup, same as the rest of the suite.
 */

test.describe("RFQ creation through the UI", () => {
  test("broadcast with a category can be sent and returns supplier matches", async ({ page }) => {
    await signInWithPassword(page, BUYER_EMAIL);
    await page.goto("/rfq");

    // Category options come from the live taxonomy; resolve the seeded
    // listing's category at runtime (the seed assigns categories
    // programmatically, so it is not hardcoded here).
    const { categoryId } = await listingCategoryFor(TARGET_LISTING_ID);

    const title = `E2E UI broadcast ${Date.now().toString(36)}`;
    await page.getByTestId("rfq-title").fill(title);
    await page.getByTestId("rfq-mode").selectOption("BROADCAST");
    await page.getByTestId("rfq-category").selectOption(categoryId);
    // 2500 units — the quantity the buyer-journey spec proves matches the
    // seeded listing's MOQ tiers.
    await page.getByTestId("rfq-quantity").fill("2500");
    await page.getByTestId("rfq-create-submit").click();

    // Success redirects to the draft detail page. RFQ ids are cuids (no
    // semantic prefix), so match the path shape, not an id format.
    await page.waitForURL(/\/rfq\/[a-z0-9]+$/i);
    await expect(page.getByTestId("rfq-detail-status")).toContainText("DRAFT");

    // The matcher received the UI-chosen category and returns matches — the
    // defect this repair closes is exactly here: without the category the
    // draft could never show matches nor be sent.
    await expect(page.getByTestId("match-list")).toBeVisible();

    // Send the draft — with a valid category this must succeed.
    await page.getByTestId("send-rfq").click();
    await expect(page.getByTestId("rfq-detail-status")).toContainText("OPEN");
  });

  test("request-a-quote deep link creates a single-listing RFQ with the inherited category", async ({ page }) => {
    await signInWithPassword(page, BUYER_EMAIL);

    // From the product page, through the real deep link.
    await page.goto(`/products/${TARGET_LISTING_SLUG}`);
    const listingTitle = (await page.getByTestId("product-title").textContent()) ?? "";
    await page.getByTestId("request-quote").click();
    await page.waitForURL(/\/rfq\?listing=/);

    // SINGLE mode is preselected and the listing's category is inherited —
    // no category selector is offered in this mode.
    await expect(page.getByTestId("rfq-mode")).toHaveValue("SINGLE");
    await expect(page.getByTestId("rfq-listing-context")).toBeVisible();
    await expect(page.getByTestId("rfq-category")).toHaveCount(0);

    const title = `E2E UI single ${Date.now().toString(36)}`;
    await page.getByTestId("rfq-title").fill(title);
    await page.getByTestId("rfq-quantity").fill("2500");
    await page.getByTestId("rfq-create-submit").click();

    await page.waitForURL(/\/rfq\/[a-z0-9]+$/i);
    await expect(page.getByTestId("rfq-detail-status")).toContainText("DRAFT");

    // The inherited category reached the matcher: the listing's own row
    // (title captured from the product page above) qualifies — it is LIVE
    // and in the same category.
    await expect(page.getByTestId("match-list")).toBeVisible();
    await expect(page.getByTestId("match-list").locator("li").first()).toContainText(listingTitle);

    await page.getByTestId("send-rfq").click();
    await expect(page.getByTestId("rfq-detail-status")).toContainText("OPEN");
  });

  test("broadcast without a category is rejected as form copy, not a domain error", async ({ page }) => {
    await signInWithPassword(page, BUYER_EMAIL);
    await page.goto("/rfq");

    await page.getByTestId("rfq-title").fill("E2E missing category");
    await page.getByTestId("rfq-mode").selectOption("BROADCAST");
    // Deliberately no category selection.
    await page.getByTestId("rfq-quantity").fill("500");
    await page.getByTestId("rfq-create-submit").click();

    await expect(page.getByTestId("form-error")).toContainText("category is required");
    await expect(page).toHaveURL(/\/rfq$/);
  });
});
