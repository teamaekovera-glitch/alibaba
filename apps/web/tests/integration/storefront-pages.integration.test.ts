import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@packsource/db";

/**
 * Buyer storefront page renders against the deterministic seed.
 *
 * Buyer-permission model (spec: public browsing; authenticated actions live in
 * the RFQ surface): every page here renders with NO session, NO auth context —
 * guest browsing is the default. Authenticated flows are only reached through
 * explicit links (e.g. the /rfq CTA), asserted below as plain anchors.
 *
 * Client-boundary stubs: the pages pull useRouter (compare button) and
 * cookies() (compare tray); a bare node render has neither, so both are
 * mocked. Everything else — Prisma queries, taxonomy attribute sets, seed
 * data — is real.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name) } : undefined,
  }),
}));

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://packsource:packsource@localhost:5432/packsource_test";

// The pages resolve their shared Prisma client through src/lib/db.ts, which
// requires DATABASE_URL in the environment — set it before the app imports run.
process.env.DATABASE_URL ??= DATABASE_URL;

const { default: ProductPage } = await import("@/app/products/[slug]/page");
const { default: ComparePage } = await import("@/app/compare/page");
const { default: SupplierProfilePage } = await import("@/app/suppliers/[slug]/page");
const { default: CoManPage } = await import("@/app/co-man/page");

describe("buyer storefront pages against the seed", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import("@packsource/db");
    prisma = new Client({ datasources: { db: { url: DATABASE_URL } } });
    // Deterministic per-suite handoff: integration suites share one database
    // and turbo schedules their tasks in nondeterministic order, so inherited
    // state is unsafe — a non-empty graph of stale or non-LIVE rows would
    // defeat a count-guarded seed (observed in CI as a dirty handoff from
    // sibling suites). Truncate the core graph (CASCADE clears every table
    // that references these rows, mirroring the seed suite's beforeAll) and
    // reseed unconditionally: order-independent by construction.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Organization", "User", "Category", "PriceBenchmark" CASCADE`,
    );
    const { seedDatabase } = await import("@packsource/db/seed");
    await seedDatabase(prisma);
    return async () => {
      await prisma.$disconnect();
    };
  });

  it("renders the product page deterministically from a seeded LIVE listing", async () => {
    const listing = await prisma.listing.findFirst({
      where: { status: "LIVE" },
      orderBy: { id: "asc" },
      include: {
        category: true,
        moqTiers: { orderBy: { minQty: "asc" } },
        leadTimes: { orderBy: { qtyMin: "asc" } },
        org: { include: { supplierProfile: { include: { plants: true } } } },
      },
    });
    expect(listing).not.toBeNull();
    if (!listing) throw new Error("seed must contain a LIVE listing");

    const html = renderToStaticMarkup(
      await ProductPage({ params: Promise.resolve({ slug: listing.slug }) }),
    );

    // Deterministic seed identity + the spec's buyer-surface sections.
    expect(html).toContain(`>${listing.title}<`);
    expect(html).toContain('data-testid="moq-ladder"');
    expect(html).toContain('data-testid="lead-time-bands"');
    expect(html).toContain('data-testid="attribute-table"');
    expect(html).toContain('data-testid="supplier-card"');
    expect(html).toContain('data-testid="reviews-placeholder"');
    expect(html).toContain("Demo data");
    // Guest-visible RFQ handoff is a plain link — auth lives in the RFQ surface.
    expect(html).toContain('href="/rfq"');
    // Ladder rows come from the listing's own MOQ tiers (integer cents).
    for (const tier of listing.moqTiers.slice(0, 3)) {
      expect(html).toContain(
        (tier.unitPriceCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }),
      );
    }
  });

  it("renders twice with identical output (deterministic from the seed)", async () => {
    const listing = await prisma.listing.findFirst({
      where: { status: "LIVE" },
      orderBy: { id: "asc" },
      select: { slug: true },
    });
    if (!listing) throw new Error("seed must contain a LIVE listing");
    const first = renderToStaticMarkup(
      await ProductPage({ params: Promise.resolve({ slug: listing.slug }) }),
    );
    const second = renderToStaticMarkup(
      await ProductPage({ params: Promise.resolve({ slug: listing.slug }) }),
    );
    expect(first).toBe(second);
  });

  it("hides non-LIVE and unknown listings from buyers (notFound)", async () => {
    const hidden = await prisma.listing.findFirst({
      where: { status: { not: "LIVE" } },
      select: { slug: true },
    });
    await expect(
      ProductPage({
        params: Promise.resolve({ slug: hidden ? hidden.slug : "seed-listing-9999" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      ProductPage({ params: Promise.resolve({ slug: "no-such-listing" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the compare page empty state without a tray cookie", async () => {
    cookieStore.clear();
    const html = renderToStaticMarkup(await ComparePage());
    expect(html).toContain('data-testid="compare-empty"');
    expect(html).toContain("compare tray is empty");
  });

  it("renders two seeded listings side by side from the compare cookie", async () => {
    const listings = await prisma.listing.findMany({
      where: { status: "LIVE" },
      orderBy: { id: "asc" },
      take: 2,
      select: { slug: true, title: true, moqTiers: { orderBy: { minQty: "asc" }, take: 1 } },
    });
    cookieStore.set("packsource_compare", listings.map((l) => l.slug).join(","));

    const html = renderToStaticMarkup(await ComparePage());
    expect(html).toContain('data-testid="compare-table"');
    for (const listing of listings) {
      expect(html).toContain(listing.title);
    }
    // Listed fields only: price, MOQ, lead time, supplier — no landed cost yet.
    expect(html).toContain('data-testid="compare-price"');
    expect(html).toContain('data-testid="compare-moq"');
    expect(html).toContain('data-testid="compare-lead"');
    expect(html).toContain("Landed-cost comparison arrives with the RFQ quote cart");
  });

  it("renders a supplier profile with plants and listings for guests", async () => {
    const org = await prisma.organization.findFirst({
      where: { supplierProfile: { isNot: null }, listings: { some: { status: "LIVE" } } },
      orderBy: { id: "asc" },
      include: {
        supplierProfile: { include: { plants: true } },
        _count: { select: { listings: true } },
      },
    });
    expect(org).not.toBeNull();
    if (!org) throw new Error("seed must contain a supplier org with LIVE listings");

    const html = renderToStaticMarkup(
      await SupplierProfilePage({ params: Promise.resolve({ slug: org.slug }) }),
    );
    expect(html).toContain(`>${org.name}<`);
    expect(html).toContain('data-testid="supplier-plant-list"');
    expect(html).toContain('data-testid="supplier-listings"');
    expect(html).toContain('href="/rfq"');
  });

  it("renders the co-man panel and filters by a seeded capability", async () => {
    const capability = await prisma.capability.findFirst({
      where: { name: { startsWith: "category:" } },
      orderBy: { id: "asc" },
    });
    const unfiltered = renderToStaticMarkup(
      await CoManPage({ searchParams: Promise.resolve({}) }),
    );
    expect(unfiltered).toContain('data-testid="co-man-list"');

    if (capability) {
      const keyword = capability.name.slice("category:".length).split("-")[0];
      const filtered = renderToStaticMarkup(
        await CoManPage({ searchParams: Promise.resolve({ capability: keyword }) }),
      );
      if (filtered.includes("co-man-card")) {
        expect(filtered).toContain('data-testid="co-man-card"');
      } else {
        expect(filtered).toContain('data-testid="co-man-empty"');
      }
    }

    const nonsense = renderToStaticMarkup(
      await CoManPage({ searchParams: Promise.resolve({ capability: "zzz-no-such-capability" }) }),
    );
    expect(nonsense).toContain('data-testid="co-man-empty"');
  });
});
