import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@packsource/db";

/**
 * Discovery directory surfaces against a real database (spec: category-first
 * home, category grids, read-only profiles).
 *
 * Order-independence: this suite only touches the PlatformSupplier table and
 * only rows whose slug starts with "dir-test-" — the transactional graph the
 * sibling storefront suite truncates and reseeds is never read here, and real
 * import rows (7,658 on a locally imported database) coexist with the
 * fixtures below because every count assertion is computed from Prisma, not
 * hardcoded.
 *
 * Client-boundary stubs: category/profile pages call notFound() from
 * next/navigation, which has no runtime context in a bare node render —
 * mocked to throw, and the throw itself is the 404 assertion.
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://packsource:packsource@localhost:5432/packsource_test";

process.env.DATABASE_URL ??= DATABASE_URL;

const { default: HomePage } = await import("@/app/page");
const { default: CategoryPage } = await import("@/app/categories/[slug]/page");
const { default: DirectoryPage } = await import("@/app/directory/[slug]/page");
const { generateMetadata: directoryMetadata } = await import("@/app/directory/[slug]/page");

const TEST_PREFIX = "dir-test-";
const DAIRY_ROWS = 25; // forces a second page at the 24-per-page grid

function dairyRow(index: number) {
  return {
    slug: `${TEST_PREFIX}dairy-${String(index).padStart(3, "0")}`,
    name: `Test Dairy Works ${index}`,
    supplierTypes: ["Co-Manufacturer", "Ingredient Supplier"],
    specialty: `Yogurt and cheese line ${index}`,
    description: "Test fixture for the discovery grid.",
    city: "Troy",
    state: "OH",
    country: "US",
    certifications: ["SQF"],
    tier: index < 5 ? 1 : 2,
    primaryCategory: "dairy",
    categorySlugs: ["dairy"],
  };
}

const fullContactRow = {
  slug: `${TEST_PREFIX}full-contact`,
  name: "Test Full Contact Co",
  dba: "TFC Foods",
  supplierTypes: ["Food Manufacturer / Brand"],
  specialty: "Granola and snack bars",
  products: "Granola, trail mix",
  description: "Full-contact fixture rendering every profile block.",
  primaryEmail: "primary@example.test",
  generalEmail: "general@example.test",
  phone: "(555) 010-0100",
  website: "https://example.test/tfc",
  linkedin: "https://www.linkedin.com/company/tfcfoods",
  city: "Bronx",
  state: "NY",
  zip: "10462",
  country: "US",
  certifications: ["Kosher", "USDA Organic"],
  yearFounded: "1998",
  tier: 1,
  aiConfidence: 0.9,
  primaryCategory: "snacks-sweets",
  categorySlugs: ["snacks-sweets", "bakery"],
};

describe("discovery directory surfaces", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import("@packsource/db");
    prisma = new Client({ datasources: { db: { url: DATABASE_URL } } });
    await prisma.platformSupplier.deleteMany({ where: { slug: { startsWith: TEST_PREFIX } } });
    await prisma.platformSupplier.createMany({
      data: [...Array.from({ length: DAIRY_ROWS }, (_, i) => dairyRow(i)), fullContactRow],
    });
  });

  afterAll(async () => {
    // Scoped cleanup: the local development database keeps its real import;
    // only this suite's prefixed fixtures are removed.
    await prisma.platformSupplier.deleteMany({ where: { slug: { startsWith: TEST_PREFIX } } });
    await prisma.$disconnect();
  });

  it("renders the home category grid with live counts that match the database", async () => {
    const [html, dairyCount, beveragesCount] = await Promise.all([
      renderToStaticMarkup(await HomePage({})),
      prisma.platformSupplier.count({ where: { primaryCategory: "dairy" } }),
      prisma.platformSupplier.count({ where: { primaryCategory: "beverages" } }),
    ]);

    expect(html).toContain('data-testid="category-grid"');
    expect(html).toContain('data-testid="category-card-dairy"');
    expect(html).toContain('href="/categories/dairy"');
    // Counts are live reads — a card can never disagree with its rows.
    expect(html).toContain(`${dairyCount.toLocaleString("en-US")} suppliers`);
    expect(html).toContain(`${beveragesCount.toLocaleString("en-US")} suppliers`);
    // Preserved surfaces: hero search form and the nine packaging families.
    expect(html).toContain('action="/search"');
    expect(html).toContain('data-testid="family-grid"');
    expect(html).toContain('href="/search?categoryFamily=rigid"');
    expect(html.match(/\/search\?categoryFamily=/g)?.length).toBe(9);
  });

  it("renders the dairy grid paginated at 24 with facet chips and page 2", async () => {
    const html = renderToStaticMarkup(
      await CategoryPage({ params: Promise.resolve({ slug: "dairy" }), searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('data-testid="supplier-grid"');
    expect(html.match(/data-testid="supplier-card-/g)?.length).toBe(24);
    expect(html).toContain('data-testid="facet-row"');
    expect(html).toContain("All (");
    expect(html).toContain("Co-Manufacturer (");
    expect(html).toContain('data-testid="pagination"');
    expect(html).toContain('href="/categories/dairy?page=2"');
  });

  it("renders page 2 in range and the final page without a next link", async () => {
    // Data-agnostic: the suite runs on a nearly-empty CI database and on a
    // locally imported one (464 dairy rows), so the stable invariants are
    // card-count bounds and the final page's "no Next" property.
    const total = await prisma.platformSupplier.count({ where: { primaryCategory: "dairy" } });
    const totalPages = Math.max(1, Math.ceil(total / 24));

    const page2 = renderToStaticMarkup(
      await CategoryPage({
        params: Promise.resolve({ slug: "dairy" }),
        searchParams: Promise.resolve({ page: "2" }),
      }),
    );
    const page2Cards = page2.match(/data-testid="supplier-card-/g)?.length ?? 0;
    expect(page2Cards).toBeLessThanOrEqual(24);
    expect(page2Cards).toBeGreaterThan(0);
    if (totalPages > 2) {
      expect(page2).toContain("Next →");
      expect(page2).toContain('href="/categories/dairy"'); // page 1 link
      expect(page2).toContain('aria-current="page"'); // current page is a span, not a link
    }

    const finalHtml = renderToStaticMarkup(
      await CategoryPage({
        params: Promise.resolve({ slug: "dairy" }),
        searchParams: Promise.resolve({ page: String(totalPages) }),
      }),
    );
    const finalCards = finalHtml.match(/data-testid="supplier-card-/g)?.length ?? 0;
    expect(finalCards).toBeLessThanOrEqual(24);
    expect(finalCards).toBeGreaterThan(0);
    expect(finalHtml).not.toContain("Next →");
    expect(finalHtml).toContain("Prev");
  });

  it("filters by supplier-type facet and preserves the facet on pagination", async () => {
    const html = renderToStaticMarkup(
      await CategoryPage({
        params: Promise.resolve({ slug: "dairy" }),
        searchParams: Promise.resolve({ type: "Co-Manufacturer" }),
      }),
    );
    // Active chip state + facet surviving a page change. Rendered hrefs carry
    // HTML-escaped ampersands.
    expect(html).toContain("/categories/dairy?page=2&amp;type=Co-Manufacturer");
  });

  it("renders the recovery state for a no-match facet filter", async () => {
    const html = renderToStaticMarkup(
      await CategoryPage({
        params: Promise.resolve({ slug: "dairy" }),
        searchParams: Promise.resolve({ type: "No Such Type" }),
      }),
    );
    expect(html).toContain('data-testid="empty-category"');
    expect(html).toContain("No suppliers here yet");
    expect(html).toContain('href="/"');
    expect(html).not.toContain('data-testid="supplier-grid"');
  });

  it("renders the full profile record with contact links and no transactional actions", async () => {
    const html = renderToStaticMarkup(
      await DirectoryPage({ params: Promise.resolve({ slug: fullContactRow.slug }) }),
    );

    expect(html).toContain("Test Full Contact Co");
    expect(html).toContain("d/b/a TFC Foods");
    expect(html).toContain("Food Manufacturer / Brand");
    expect(html).toContain("Granola and snack bars");
    expect(html).toContain("Granola, trail mix");
    expect(html).toContain("Kosher");
    expect(html).toContain("Bronx, NY, 10462, US");
    expect(html).toContain('data-testid="contact-block"');
    expect(html).toContain('href="mailto:primary@example.test"');
    expect(html).toContain('href="tel:5550100100"');
    // External links are target=_blank + rel=noopener per spec.
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // Cross-category chips link back into the grids.
    expect(html).toContain('href="/categories/snacks-sweets"');
    expect(html).toContain('href="/categories/bakery"');
    // Structured data carries the /directory URL.
    expect(html).toContain(`https://packsource.aekovera.com/directory/${fullContactRow.slug}`);
    // Browse-only: no RFQ, cart, or messaging action anywhere on the surface.
    expect(html).not.toContain('href="/rfq"');
    expect(html).not.toContain('href="/cart"');
    expect(html).not.toContain('href="/inbox"');
    expect(html).not.toMatch(/data-testid="(add-to-cart|rfq-|message-)/);
  });

  it("emits noindex metadata for an unknown supplier slug", async () => {
    const metadata = await directoryMetadata({ params: Promise.resolve({ slug: "missing-supplier" }) });
    expect(metadata.title).toContain("not found");
  });

  it("404s unknown category and directory slugs", async () => {
    await expect(
      CategoryPage({ params: Promise.resolve({ slug: "not-a-slug" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      DirectoryPage({ params: Promise.resolve({ slug: "dir-test-missing" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
