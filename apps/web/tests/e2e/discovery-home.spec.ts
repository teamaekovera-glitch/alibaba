import { expect, test } from "@playwright/test";

/**
 * Discovery directory e2e (guest browsing — no sign-in). The e2e database is
 * reset and fictionally seeded on every run and carries NO imported
 * PlatformSupplier rows, so this spec deterministically covers the zero-data
 * state: live category cards with "Coming soon" counts and the category
 * page's recovery state. Count-visible grids over imported records are
 * covered by the integration suite and the PR's dogfood evidence.
 */
test("discovery: home category grid links into a category and back", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Find the right supplier by product category" })).toBeVisible();
  await expect(page.getByTestId("category-grid")).toBeVisible();

  // Sixteen discovery categories render as links.
  await expect(page.locator('[data-testid="category-grid"] a[href^="/categories/"]')).toHaveCount(16);
  // Zero directory rows in the e2e database → the counts stay honest.
  await expect(page.getByTestId("category-count").first()).toContainText("Coming soon");
  // Preserved surfaces: hero search form and the nine packaging families.
  await expect(page.locator('[data-testid="family-grid"] a[href^="/search?categoryFamily="]')).toHaveCount(9);

  // Click-through: category card → grid page.
  await page.getByTestId("category-card-dairy").click();
  await expect(page).toHaveURL(/\/categories\/dairy$/);
  await expect(page.getByRole("heading", { name: "Dairy & Cheese" })).toBeVisible();
  await expect(page.getByTestId("empty-category")).toBeVisible();

  // The recovery state links home instead of rendering a blank grid.
  await page.getByTestId("empty-category").getByRole("link", { name: "Back to all categories" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("category-grid")).toBeVisible();
});

test("discovery: hero search still resolves to /search", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search packaging listings").fill("32 oz PET bottle");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.getByTestId("search-experience")).toBeVisible();
});
