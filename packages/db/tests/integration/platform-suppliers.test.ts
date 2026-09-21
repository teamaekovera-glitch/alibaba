import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  categoryCounts,
  getDirectorySupplier,
  listByCategory,
} from "../../src/discovery/repository";
import { importPlatformSuppliersCsv } from "../../src/discovery/import";
import { DISCOVERY_CATEGORY_SLUGS, OTHER_GENERAL_SLUG } from "../../src/discovery/taxonomy";

/**
 * Directory import + read-only repository against the pgvector/pg16 service
 * container, using the committed 7,658-row Platform Ready fixture. Spec
 * acceptance: the import lands exactly 7,658 rows, a second run creates zero
 * new rows, counts match the rows behind them, and unknown slugs return null.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const FIXTURE_PATH = path.join(
  pkgRoot,
  "fixtures",
  "platform-suppliers",
  "platform-ready-20260817.csv",
);

beforeAll(() => {
  execSync("npx prisma migrate deploy", {
    cwd: pkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return prisma.platformSupplier.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Assigned by the import test; read by the counts tests further down. */
let summary: Awaited<ReturnType<typeof importPlatformSuppliersCsv>>;

describe("platform-supplier import (7,658-row fixture)", () => {
  it("imports the fixture into exactly 7,658 rows with no errors", async () => {
    const csvText = readFileSync(FIXTURE_PATH, "utf8");
    summary = await importPlatformSuppliersCsv(prisma, csvText);

    expect(summary.inputRowCount).toBe(7658);
    expect(summary.errorRows).toEqual([]);
    expect(summary.createdCount).toBe(7658);
    expect(await prisma.platformSupplier.count()).toBe(7658);
  }, 180_000); // 7,658 transactional batch upserts — well over vitest's 5s default.

  it("re-runs idempotently: zero new rows, everything updated in place", async () => {
    const csvText = readFileSync(FIXTURE_PATH, "utf8");
    const rerun = await importPlatformSuppliersCsv(prisma, csvText);

    expect(rerun.createdCount).toBe(0);
    expect(rerun.updatedCount).toBe(7658);
    expect(await prisma.platformSupplier.count()).toBe(7658);
  }, 180_000);

  it("gives every row a recognized, non-empty primary category", async () => {
    const distinct = await prisma.platformSupplier.findMany({
      select: { primaryCategory: true },
      distinct: ["primaryCategory"],
    });
    expect(distinct.length).toBeGreaterThan(0);
    for (const row of distinct) {
      expect(DISCOVERY_CATEGORY_SLUGS).toContain(row.primaryCategory);
    }
  });

  it("reports per-category counts that match the database exactly", () => {
    const total = Object.values(summary.categoryCounts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(7658);
    expect(Object.keys(summary.categoryCounts)).toContain(OTHER_GENERAL_SLUG);
  });
});

describe("categoryCounts()", () => {
  it("covers every taxonomy slug and matches the import report per slug", async () => {
    const counts = await categoryCounts(prisma);
    expect(Object.keys(counts).sort()).toEqual([...DISCOVERY_CATEGORY_SLUGS].sort());

    const sum = Object.values(counts).reduce((acc, n) => acc + n, 0);
    expect(sum).toBe(7658);

    for (const [slug, n] of Object.entries(summary.categoryCounts)) {
      expect(counts[slug], `categoryCounts[${slug}]`).toBe(n);
    }
  });
});

describe("listByCategory()", () => {
  it("paginates the largest category 24 per page with working page 2", async () => {
    const slug = "meat-poultry";
    const counts = await categoryCounts(prisma);
    const page1 = await listByCategory(prisma, { slug });
    expect(page1.items.length).toBe(24);
    expect(page1.total).toBe(counts[slug]);

    const page2 = await listByCategory(prisma, { slug, page: 2 });
    expect(page2.items.length).toBe(24);
    const page1Slugs = new Set(page1.items.map((item) => item.slug));
    for (const item of page2.items) {
      expect(page1Slugs.has(item.slug)).toBe(false);
    }

    const lastPage = await listByCategory(prisma, { slug, page: Math.ceil(page1.total / 24) });
    expect(lastPage.items.length).toBeGreaterThan(0);
    expect(lastPage.items.length).toBeLessThanOrEqual(24);
  });

  it("sorts by tier ascending with nulls last", async () => {
    const page1 = await listByCategory(prisma, { slug: "meat-poultry" });
    const tiers = page1.items.map((item) => item.tier);
    const nonNull = tiers.filter((tier) => tier !== null);
    // Nulls only after every non-null tier.
    expect(nonNull.length).toBeGreaterThan(0);
    expect(tiers.slice(0, nonNull.length)).toEqual(nonNull);
    for (let i = 1; i < nonNull.length; i += 1) {
      expect(nonNull[i] ?? Infinity).toBeGreaterThanOrEqual(nonNull[i - 1] ?? 0);
    }
  });

  it("filters by supplier type and keeps facets consistent with that filter", async () => {
    const listing = await listByCategory(prisma, { slug: "meat-poultry" });
    expect(listing.facetTypes.length).toBeGreaterThan(0);
    // Count-desc then name-asc ordering on the facet chips.
    for (let i = 1; i < listing.facetTypes.length; i += 1) {
      const prev = listing.facetTypes[i - 1];
      const curr = listing.facetTypes[i];
      if (prev && curr) {
        expect(prev.n).toBeGreaterThanOrEqual(curr.n);
      }
    }

    const top = listing.facetTypes[0];
    expect(top).toBeDefined();
    if (!top) return;
    const filtered = await listByCategory(prisma, {
      slug: "meat-poultry",
      supplierType: top.type,
    });
    expect(filtered.total).toBe(top.n);
    for (const item of filtered.items) {
      expect(item.supplierTypes).toContain(top.type);
    }
  });

  it("respects pageSize and name sort overrides", async () => {
    const listing = await listByCategory(prisma, { slug: "bakery", pageSize: 5, sort: "name" });
    expect(listing.items.length).toBe(5);
    // The oracle for name order is the database's own collation, not JS
    // localeCompare — the repository must apply the same ORDER BY as raw SQL.
    const expected = await prisma.$queryRaw<{ name: string }[]>`
      SELECT "name" FROM "PlatformSupplier"
      WHERE "primaryCategory" = 'bakery'
      ORDER BY "name" ASC
      LIMIT 5`;
    expect(listing.items.map((item) => item.name)).toEqual(expected.map((row) => row.name));
  });
});

describe("getDirectorySupplier()", () => {
  it("returns a full real record by slug", async () => {
    const supplier = await getDirectorySupplier(prisma, "flatlands-processing");
    expect(supplier).not.toBeNull();
    expect(supplier?.name).toBe("Flatlands Processing LLC");
    expect(supplier?.primaryCategory).toBe("grains-baking");
    expect(supplier?.city).toBe("Haxtun");
    expect(supplier?.state).toBe("CO");
    expect(supplier?.certifications).toContain("USDA Organic");
  });

  it("returns null for an unknown slug", async () => {
    const supplier = await getDirectorySupplier(prisma, "no-such-supplier-slug");
    expect(supplier).toBeNull();
  });
});
