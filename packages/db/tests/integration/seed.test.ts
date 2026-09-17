import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { flattenTaxonomy } from "../../src/index";
import { seedDatabase, type SeedSummary } from "../../src/seed/seed";

/**
 * Seed integration tests, run against the pgvector/pg16 service container
 * (spec verification table: rerunning the seed yields identical ids and
 * content; seeded counts are asserted; every seeded row is fictional).
 *
 * seedDatabase wipes previous seed_* rows itself, so the suite is safe to
 * rerun; assertions filter on the seed_ prefix so rows written by other
 * suites never pollute the counts. beforeAll still truncates the core
 * tables: sibling suites write plain rows (e.g. the schema round-trip's
 * "rigid" category) whose unique fields would collide with the taxonomy
 * the seed creates.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

beforeAll(async () => {
  // CI's service container starts empty — apply the committed migrations here.
  execSync("npx prisma migrate deploy", {
    cwd: pkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  // Start from a clean core graph regardless of what earlier suites left
  // behind; CASCADE clears every table that references these rows.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "Category", "PriceBenchmark" CASCADE`,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Stable hash over every seeded row, table by table, ordered by id. */
async function seedStateHash(): Promise<string> {
  const findArgs = { where: { id: { startsWith: "seed_" } }, orderBy: { id: "asc" } } as const;
  const snapshots = await Promise.all([
    prisma.category.findMany(findArgs),
    prisma.organization.findMany(findArgs),
    prisma.supplierProfile.findMany(findArgs),
    prisma.plant.findMany(findArgs),
    prisma.user.findMany(findArgs),
    prisma.orgMembership.findMany(findArgs),
    prisma.listing.findMany(findArgs),
    prisma.moqPriceTier.findMany(findArgs),
    prisma.leadTimeRule.findMany(findArgs),
    prisma.capability.findMany(findArgs),
    prisma.order.findMany(findArgs),
    prisma.subOrder.findMany(findArgs),
    prisma.orderLine.findMany(findArgs),
    prisma.review.findMany(findArgs),
  ]);
  return createHash("sha256").update(JSON.stringify(snapshots)).digest("hex");
}

describe("deterministic fictional seed", () => {
  let first: SeedSummary;
  let firstHash: string;

  it("seeds the documented volumes", { timeout: 60_000 }, async () => {
    first = await seedDatabase(prisma);

    expect(first.supplierOrgs).toBe(150);
    expect(first.buyerOrgs).toBe(40);
    expect(first.listings).toBe(1200);
    expect(first.users).toBe(40);
    expect(first.categories).toBe(flattenTaxonomy().length);
    expect(first.orders).toBe(60);
    expect(first.reviews).toBe(30);
    // Every listing carries at least a two-step MOQ ladder and a lead-time rule.
    expect(first.moqTiers).toBeGreaterThanOrEqual(2 * 1200);
    expect(first.leadTimeRules).toBeGreaterThanOrEqual(1200);
    expect(await prisma.organization.count({ where: { id: { startsWith: "seed_" } } })).toBe(190);
  });

  it("covers all nine top-level categories with listings", async () => {
    const listings = await prisma.listing.findMany({
      where: { id: { startsWith: "seed_" } },
      select: { categoryId: true },
    });
    const usedCategoryIds = new Set(listings.map((listing) => listing.categoryId));
    const categories = await prisma.category.findMany({
      where: { id: { startsWith: "seed_" } },
      select: { id: true, parentId: true },
    });
    const topIds = new Set(
      categories.filter((category) => category.parentId === null).map((category) => category.id),
    );
    const coveredTops = new Set<string>();
    for (const categoryId of usedCategoryIds) {
      if (categoryId === undefined) continue;
      if (topIds.has(categoryId)) {
        coveredTops.add(categoryId);
      } else {
        const parent = categories.find((category) => category.id === categoryId)?.parentId;
        if (parent !== undefined && parent !== null) coveredTops.add(parent);
      }
    }
    expect(coveredTops.size).toBe(9);
    expect(coveredTops).toEqual(topIds);
  });

  it("marks every seeded listing fictional", async () => {
    const [total, nonFictional] = await Promise.all([
      prisma.listing.count({ where: { id: { startsWith: "seed_" } } }),
      prisma.listing.count({ where: { id: { startsWith: "seed_" }, seedIsFictional: false } }),
    ]);
    expect(total).toBe(1200);
    expect(nonFictional).toBe(0);
  });

  it("builds descending MOQ ladders with lead-time rules", async () => {
    const tiers = await prisma.moqPriceTier.findMany({
      where: { id: { startsWith: "seed_" } },
      select: { listingId: true, minQty: true, unitPriceCents: true },
      orderBy: { minQty: "asc" },
    });
    const byListing = new Map<string, { minQty: number; unitPriceCents: number }[]>();
    for (const tier of tiers) {
      const list = byListing.get(tier.listingId) ?? [];
      list.push({ minQty: tier.minQty, unitPriceCents: tier.unitPriceCents });
      byListing.set(tier.listingId, list);
    }
    expect(byListing.size).toBe(1200);
    for (const ladder of byListing.values()) {
      expect(ladder.length).toBeGreaterThanOrEqual(2);
      for (let t = 1; t < ladder.length; t += 1) {
        const previous = ladder[t - 1];
        const current = ladder[t];
        if (previous === undefined || current === undefined) continue;
        expect(current.minQty).toBeGreaterThan(previous.minQty);
        expect(current.unitPriceCents).toBeLessThanOrEqual(previous.unitPriceCents);
      }
    }

    const rules = await prisma.leadTimeRule.count({ where: { id: { startsWith: "seed_" } } });
    expect(rules).toBeGreaterThanOrEqual(1200);
  });

  it("reviews only orders that reached a reviewed status", async () => {
    const reviews = await prisma.review.findMany({
      where: { id: { startsWith: "seed_" } },
      select: { orderId: true },
    });
    expect(reviews.length).toBeGreaterThan(0);
    const reviewedOrders = await prisma.order.findMany({
      where: { id: { in: reviews.map((review) => review.orderId) } },
      select: { status: true },
    });
    for (const order of reviewedOrders) {
      expect(["CLOSED", "DELIVERED", "ESCROW_RELEASED"]).toContain(order.status);
    }
  });

  it("reproduces identical rows and ids on rerun", { timeout: 120_000 }, async () => {
    firstHash = await seedStateHash();
    const second = await seedDatabase(prisma);
    const secondHash = await seedStateHash();

    expect(second).toEqual(first);
    expect(secondHash).toBe(firstHash);
    // Wipe-and-recreate leaves no duplicate accumulations behind.
    expect(await prisma.organization.count({ where: { id: { startsWith: "seed_" } } })).toBe(190);
    expect(await prisma.listing.count({ where: { id: { startsWith: "seed_" } } })).toBe(1200);
  });
});
