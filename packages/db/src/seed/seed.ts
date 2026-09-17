import { PrismaClient, Prisma, type StockLevel } from "@prisma/client";
import { flattenTaxonomy, categoryDefinition, assertTopLevelSlugKeys } from "../taxonomy/categories";
import { generateListingAttributes } from "./attributes";
import { categoryImageDataUris } from "./images";
import {
  SUPPLIER_ROOTS,
  SUPPLIER_SUFFIXES,
  BUYER_NAMES,
  BUYER_CITIES,
  BUYER_USER_NAMES,
  listingTitle,
  REVIEW_TITLES,
  REVIEW_BODIES,
} from "./names";
import { mulberry32, weighted } from "./rng";

/**
 * Deterministic fictional seed (spec: Data Migration → Seed).
 *
 *   150 supplier orgs · 1200 listings across all 9 top-level categories
 *   (MOQ price ladders, lead-time rules, stock indicators, generated PNG
 *   placeholder art) · 40 buyer orgs with owner users · sample orders and
 *   reviews sufficient for storefront and admin analytics.
 *
 * Determinism contract: every row has a fixed `seed_*` id and content derived
 * from index arithmetic + mulberry32 — no wall-clock, no RNG drift. Rerunning
 * wipes the previous seed_* rows and recreates identical ones, which is what
 * the determinism integration test asserts. seedIsFictional=true is set on
 * every seeded Listing (the only model carrying the column); suppliers,
 * buyers, orders, and reviews are fictional by construction and reference
 * only seeded rows.
 */

const SEED_PREFIX = "seed_";
const SUPPLIER_COUNT = 150;
const LISTING_COUNT = 1200;
const BUYER_COUNT = 40;
const ORDER_COUNT = 60;
/** Fixed epoch: 2026-01-05T00:00:00Z — never Date.now() in the seeder. */
const SEED_EPOCH = Date.parse("2026-01-05T00:00:00.000Z");

/** Realistic per-unit base prices (cents) per top-level category. */
const CATEGORY_BASE_PRICE_CENTS: Record<string, number> = {
  rigid: 42,
  flexible: 14,
  corrugated: 55,
  paperboard: 38,
  "labels-shrink-sleeves": 6,
  "closures-caps": 24,
  "trays-clamshells": 18,
  "secondary-tertiary": 95,
  "sustainable-compostable": 48,
};

// Fail fast at import time if this table drifts from the canonical taxonomy
// slugs (same CI-caught failure class as the title banks).
assertTopLevelSlugKeys("CATEGORY_BASE_PRICE_CENTS", Object.keys(CATEGORY_BASE_PRICE_CENTS));

const ORDER_STATUS_CYCLE = [
  "CLOSED", "CLOSED", "ESCROW_RELEASED", "DELIVERED", "CLOSED", "IN_PRODUCTION",
  "SHIPPED", "CLOSED", "DEPOSIT_PAID", "BALANCE_DUE", "READY_TO_SHIP", "PARTIALLY_REFUNDED",
] as const;
const REVIEWED_STATUSES: readonly string[] = ["CLOSED", "DELIVERED", "ESCROW_RELEASED"];
const PAYMENT_SCHEDULES = ["DEPOSIT_30_70", "FULL_PREPAY", "NET_30"] as const;
const PAYMENT_TERMS = ["NET_30", "NET_15", "NET_45", "DEPOSIT_50_50", "FULL_PREPAY"] as const;
const MOQ_LADDER = [500, 2500, 10000, 50000] as const;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function placeAt(index: number): { city: string; state: string } {
  const place = BUYER_CITIES[index % BUYER_CITIES.length];
  if (place === undefined) throw new Error(`city bank underflow at ${index}`);
  return place;
}

export interface SeedSummary {
  categories: number;
  supplierOrgs: number;
  buyerOrgs: number;
  users: number;
  supplierProfiles: number;
  plants: number;
  capabilities: number;
  listings: number;
  moqTiers: number;
  leadTimeRules: number;
  orders: number;
  subOrders: number;
  orderLines: number;
  reviews: number;
}

/** Deletes every seeded row, children first (FK-safe). */
function wipeSeededRows(tx: Prisma.TransactionClient): void {
  tx.review.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.orderLine.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.subOrder.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.order.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.moqPriceTier.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.leadTimeRule.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.listing.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.orgMembership.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.user.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.capability.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.plant.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.supplierProfile.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.organization.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  tx.category.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
}

export async function seedDatabase(client: PrismaClient): Promise<SeedSummary> {
  const rng = mulberry32(0x5eed1500);

  const flat = flattenTaxonomy();
  const topSlugs = flat.filter((entry) => entry.parentSlug === null).map((entry) => entry.slug);
  if (topSlugs.length !== 9) {
    throw new Error(`Expected 9 top-level categories, found ${topSlugs.length}`);
  }
  const childrenByTop = new Map<string, string[]>(
    topSlugs.map((slug) => [
      slug,
      flat.filter((entry) => entry.parentSlug === slug).map((entry) => entry.slug),
    ]),
  );
  const art = categoryImageDataUris(topSlugs);

  // ── Category rows ──────────────────────────────────────────────────────────
  const categoryRows: Prisma.CategoryCreateManyInput[] = flat.map((entry) => ({
    id: `${SEED_PREFIX}cat_${entry.slug}`,
    parentId: entry.parentSlug === null ? null : `${SEED_PREFIX}cat_${entry.parentSlug}`,
    name: entry.name,
    slug: entry.slug,
    position: entry.position,
    attributeSet: categoryDefinition(entry.slug)?.attributeSet ?? {},
    isActive: true,
    createdAt: new Date(SEED_EPOCH),
    updatedAt: new Date(SEED_EPOCH),
  }));

  // ── Supplier orgs, profiles, plants ────────────────────────────────────────
  const supplierOrgRows: Prisma.OrganizationCreateManyInput[] = [];
  const supplierProfileRows: Prisma.SupplierProfileCreateManyInput[] = [];
  const plantRows: Prisma.PlantCreateManyInput[] = [];

  for (let i = 0; i < SUPPLIER_COUNT; i += 1) {
    const orgId = `${SEED_PREFIX}org_supplier_${pad(i + 1, 3)}`;
    const root = SUPPLIER_ROOTS[i % SUPPLIER_ROOTS.length];
    const suffix = SUPPLIER_SUFFIXES[Math.floor(i / SUPPLIER_ROOTS.length) % SUPPLIER_SUFFIXES.length];
    const name = `${root} ${suffix}`;
    const place = placeAt(i);

    supplierOrgRows.push({
      id: orgId,
      type: "SUPPLIER",
      name,
      slug: `seed-supplier-${pad(i + 1, 3)}`,
      billingEmail: `hello@seed-supplier-${pad(i + 1, 3)}.example`,
      createdAt: new Date(SEED_EPOCH + i * 60_000),
      updatedAt: new Date(SEED_EPOCH + i * 60_000),
    });
    supplierProfileRows.push({
      id: `${SEED_PREFIX}profile_${pad(i + 1, 3)}`,
      orgId,
      verificationStatus: i % 5 < 2 ? "VERIFIED" : "UNVERIFIED", // demo trust mix
      responseTimeHours: 2 + (i % 12),
      minOrderValueCents: 25_000 + (i % 10) * 5_000,
      paymentTerms: PAYMENT_TERMS[i % PAYMENT_TERMS.length],
      about:
        `Fictional ${name} is a family-run converter with ${2 + (i % 4)} plants and a focus on ` +
        "sustainable substrates. This profile was generated by the PackSource demo seed.",
      createdAt: new Date(SEED_EPOCH + i * 60_000),
      updatedAt: new Date(SEED_EPOCH + i * 60_000),
    });
    plantRows.push({
      id: `${SEED_PREFIX}plant_${pad(i + 1, 3)}_a`,
      orgId,
      supplierProfileId: `${SEED_PREFIX}profile_${pad(i + 1, 3)}`,
      name: "Primary plant",
      city: place.city,
      state: place.state,
      country: "US",
      isPrimary: true,
    });
    if (i % 4 === 0) {
      const otherPlace = placeAt(i + 3);
      plantRows.push({
        id: `${SEED_PREFIX}plant_${pad(i + 1, 3)}_b`,
        orgId,
        supplierProfileId: `${SEED_PREFIX}profile_${pad(i + 1, 3)}`,
        name: "Secondary plant",
        city: otherPlace.city,
        state: otherPlace.state,
        country: "US",
        isPrimary: false,
      });
    }
  }

  // ── Buyer orgs, users, memberships ─────────────────────────────────────────
  const buyerOrgRows: Prisma.OrganizationCreateManyInput[] = [];
  const userRows: Prisma.UserCreateManyInput[] = [];
  const membershipRows: Prisma.OrgMembershipCreateManyInput[] = [];

  for (let i = 0; i < BUYER_COUNT; i += 1) {
    const orgId = `${SEED_PREFIX}org_buyer_${pad(i + 1, 2)}`;
    const name = BUYER_NAMES[i];
    if (name === undefined) throw new Error(`buyer name bank underflow at ${i}`);
    const userName = BUYER_USER_NAMES[i];
    if (userName === undefined) throw new Error(`buyer user name bank underflow at ${i}`);
    buyerOrgRows.push({
      id: orgId,
      type: "BUYER",
      name,
      slug: `seed-buyer-${pad(i + 1, 2)}`,
      billingEmail: `billing@seed-buyer-${pad(i + 1, 2)}.example`,
      createdAt: new Date(SEED_EPOCH + i * 60_000),
      updatedAt: new Date(SEED_EPOCH + i * 60_000),
    });
    userRows.push({
      id: `${SEED_PREFIX}user_${pad(i + 1, 2)}`,
      email: `buyer${pad(i + 1, 2)}@seed.packsource.example`,
      emailVerified: new Date(SEED_EPOCH),
      name: userName,
      createdAt: new Date(SEED_EPOCH + i * 60_000),
      updatedAt: new Date(SEED_EPOCH + i * 60_000),
    });
    membershipRows.push({
      id: `${SEED_PREFIX}member_${pad(i + 1, 2)}`,
      orgId,
      userId: `${SEED_PREFIX}user_${pad(i + 1, 2)}`,
      role: "OWNER",
      createdAt: new Date(SEED_EPOCH + i * 60_000),
    });
  }

  // ── Listings + ladders + lead times ────────────────────────────────────────
  const listingRows: Prisma.ListingCreateManyInput[] = [];
  const moqTierRows: Prisma.MoqPriceTierCreateManyInput[] = [];
  const leadTimeRows: Prisma.LeadTimeRuleCreateManyInput[] = [];
  // Per-supplier listing ids and top-level categories, used for orders and
  // capabilities below.
  const listingsBySupplier: string[][] = Array.from({ length: SUPPLIER_COUNT }, () => []);
  const topBySupplier: string[][] = Array.from({ length: SUPPLIER_COUNT }, () => []);

  for (let i = 0; i < LISTING_COUNT; i += 1) {
    const supplierIndex = i % SUPPLIER_COUNT;
    const supplierOrgId = supplierOrgRows[supplierIndex]?.id;
    if (supplierOrgId === undefined) throw new Error(`no supplier org at ${supplierIndex}`);

    const topSlug = topSlugs[i % topSlugs.length];
    if (topSlug === undefined) throw new Error(`no top slug at ${i}`);
    const childPool = [topSlug, ...(childrenByTop.get(topSlug) ?? [])];
    const categorySlug = childPool[Math.floor(i / topSlugs.length) % childPool.length];
    if (categorySlug === undefined) throw new Error(`empty category pool for ${topSlug}`);
    const listingId = `${SEED_PREFIX}listing_${pad(i + 1, 4)}`;
    const title = listingTitle(categorySlug, Math.floor(i / topSlugs.length));

    const status = i % 20 < 17 ? "LIVE" : i % 20 === 17 ? "PAUSED" : "DRAFT";
    const stockLevel: StockLevel = weighted<StockLevel>(rng, [
      { value: "MADE_TO_ORDER", weight: 0.5 },
      { value: "IN_STOCK", weight: 0.3 },
      { value: "LOW", weight: 0.12 },
      { value: "OUT_OF_STOCK", weight: 0.08 },
    ]);

    const imageCount = 1 + (i % 3);
    const artUrl = art.get(topSlug);
    if (artUrl === undefined) throw new Error(`no art for category ${topSlug}`);
    const images = Array.from({ length: imageCount }, (_, position) => ({
      url: artUrl,
      alt: `${title} — demo placeholder`,
      position,
    }));

    listingRows.push({
      id: listingId,
      orgId: supplierOrgId,
      categoryId: `${SEED_PREFIX}cat_${categorySlug}`,
      title,
      slug: `seed-listing-${pad(i + 1, 4)}`,
      description:
        `Fictional demo listing for ${title}. Food-contact packaging produced on ` +
        `${2 + (i % 5)}-color presses with full dieline support.`,
      status,
      attributes: generateListingAttributes(rng, categorySlug),
      images,
      viewCount: (i * 37) % 4200,
      stockLevel,
      capacityUnitsPerWeek: (5 + (i % 10) * 5) * 1_000,
      seedIsFictional: true, // the seeder is the only writer of this flag
      publishedAt: status === "LIVE" ? new Date(SEED_EPOCH + i * 30 * 60_000) : null,
      createdAt: new Date(SEED_EPOCH + i * 60_000),
      updatedAt: new Date(SEED_EPOCH + i * 60_000),
    });

    // MOQ price ladder: descending unit price with rising quantity, jittered
    // per listing for realistic spread.
    const base = CATEGORY_BASE_PRICE_CENTS[topSlug] ?? 40;
    const tierCount = 2 + (i % 3);
    for (let t = 0; t < tierCount; t += 1) {
      const minQty = MOQ_LADDER[t];
      if (minQty === undefined) throw new Error(`MOQ ladder underflow at tier ${t}`);
      const unitPriceCents = Math.max(
        1,
        Math.round(base * (1 - 0.08 * t) * (1 + ((i % 9) - 4) * 0.01)),
      );
      moqTierRows.push({
        id: `${SEED_PREFIX}moq_${pad(i + 1, 4)}_${t}`,
        listingId,
        orgId: supplierOrgId,
        minQty,
        unitPriceCents,
      });
    }

    // Lead-time rules: base rule plus a longer-run rule on every other listing.
    const productionDays = 6 + (i % 18);
    leadTimeRows.push({
      id: `${SEED_PREFIX}lead_${pad(i + 1, 4)}_a`,
      listingId,
      orgId: supplierOrgId,
      qtyMin: MOQ_LADDER[0] ?? 500,
      qtyMax: null,
      productionDays,
    });
    if (i % 2 === 0) {
      leadTimeRows.push({
        id: `${SEED_PREFIX}lead_${pad(i + 1, 4)}_b`,
        listingId,
        orgId: supplierOrgId,
        qtyMin: MOQ_LADDER[2] ?? 10_000,
        qtyMax: null,
        productionDays: productionDays + 9,
      });
    }

    listingsBySupplier[supplierIndex]?.push(listingId);
    const tops = topBySupplier[supplierIndex];
    if (tops !== undefined && !tops.includes(topSlug)) tops.push(topSlug);
  }

  // ── Capabilities per supplier (from assigned categories) ───────────────────
  const capabilityRows: Prisma.CapabilityCreateManyInput[] = [];
  for (let s = 0; s < SUPPLIER_COUNT; s += 1) {
    const orgId = supplierOrgRows[s]?.id;
    const profileId = supplierProfileRows[s]?.id;
    if (orgId === undefined || profileId === undefined) {
      throw new Error(`supplier rows missing at index ${s}`);
    }
    for (const top of topBySupplier[s] ?? []) {
      capabilityRows.push({
        id: `${SEED_PREFIX}cap_${pad(s + 1, 3)}_${top.replace(/[^a-z0-9]/g, "-")}`,
        orgId,
        supplierProfileId: profileId,
        name: `category:${top}`,
        detail: "Seeded demo capability",
      });
    }
    if (s % 3 === 0) {
      capabilityRows.push({
        id: `${SEED_PREFIX}cap_${pad(s + 1, 3)}_cert`,
        orgId,
        supplierProfileId: profileId,
        name: "claimed-cert:SQF",
        detail: "Fictional claimed certification for demo analytics",
      });
    }
  }

  // ── Orders, sub-orders, lines ──────────────────────────────────────────────
  const orderRows: Prisma.OrderCreateManyInput[] = [];
  const subOrderRows: Prisma.SubOrderCreateManyInput[] = [];
  const orderLineRows: Prisma.OrderLineCreateManyInput[] = [];
  interface ReviewPlan {
    orderIndex: number;
    buyerIndex: number;
    supplierIndex: number;
    listingId: string;
    placedAt: Date;
  }
  const reviewPlans: ReviewPlan[] = [];

  for (let j = 0; j < ORDER_COUNT; j += 1) {
    const buyerIndex = j % BUYER_COUNT;
    const supplierIndex = (j * 7 + 3) % SUPPLIER_COUNT;
    const orderId = `${SEED_PREFIX}order_${pad(j + 1, 3)}`;
    const status = ORDER_STATUS_CYCLE[j % ORDER_STATUS_CYCLE.length];
    if (status === undefined) throw new Error(`order status underflow at ${j}`);
    const paymentSchedule = PAYMENT_SCHEDULES[j % PAYMENT_SCHEDULES.length];
    if (paymentSchedule === undefined) throw new Error(`payment schedule underflow at ${j}`);
    const placedAt = new Date(SEED_EPOCH + j * 36 * 3_600_000);
    const buyerOrgId = buyerOrgRows[buyerIndex]?.id;
    const buyerUserId = userRows[buyerIndex]?.id;
    const supplierOrgId = supplierOrgRows[supplierIndex]?.id;
    if (buyerOrgId === undefined || buyerUserId === undefined || supplierOrgId === undefined) {
      throw new Error(`order ${j} references missing seeded rows`);
    }

    const supplierListings = listingsBySupplier[supplierIndex] ?? [];
    const lineCount = 1 + (j % 3);
    let subtotal = 0;
    for (let line = 0; line < lineCount; line += 1) {
      const listingId = supplierListings[line];
      if (listingId === undefined) throw new Error(`supplier ${supplierIndex} has no listing ${line}`);
      const firstTier = moqTierRows.find(
        (tier) => tier.listingId === listingId && tier.minQty === (MOQ_LADDER[0] ?? 500),
      );
      const unitPriceCents = firstTier?.unitPriceCents ?? 50;
      const quantity = (MOQ_LADDER[0] ?? 500) * (1 + ((j + line) % 4));
      const totalCents = unitPriceCents * quantity;
      subtotal += totalCents;
      const listingTitleText =
        listingRows.find((row) => row.id === listingId)?.title ?? listingId;
      orderLineRows.push({
        id: `${SEED_PREFIX}line_${pad(j + 1, 3)}_${line}`,
        orderId,
        subOrderId: `${SEED_PREFIX}suborder_${pad(j + 1, 3)}`,
        orgId: buyerOrgId,
        listingId,
        description: listingTitleText,
        quantity,
        unitPriceCents,
        totalCents,
        createdAt: placedAt,
      });
    }

    const tooling = j % 3 === 0 ? 25_000 : 0;
    const freight = 45_000 + (j % 7) * 2_500;
    const tax = Math.round(subtotal * 0.07);
    orderRows.push({
      id: orderId,
      orgId: buyerOrgId,
      buyerUserId,
      status,
      paymentSchedule,
      subtotalCents: subtotal,
      toolingCents: tooling,
      plateChargesCents: 0,
      freightCents: freight,
      dutyCents: 0,
      taxCents: tax,
      totalCents: subtotal + tooling + freight + tax,
      commissionBps: 500,
      placedAt,
      closedAt: status === "CLOSED" ? new Date(placedAt.getTime() + 20 * 86_400_000) : null,
      createdAt: placedAt,
      updatedAt: placedAt,
    });
    subOrderRows.push({
      id: `${SEED_PREFIX}suborder_${pad(j + 1, 3)}`,
      orderId,
      orgId: supplierOrgId,
      subtotalCents: subtotal,
      toolingCents: tooling,
      plateChargesCents: 0,
      freightCents: freight,
      totalCents: subtotal + tooling + freight,
      createdAt: placedAt,
      updatedAt: placedAt,
    });

    if (REVIEWED_STATUSES.includes(status)) {
      reviewPlans.push({
        orderIndex: j,
        buyerIndex,
        supplierIndex,
        listingId: supplierListings[0] ?? listingRows[0]?.id ?? orderId,
        placedAt,
      });
    }
  }

  // ── Reviews ────────────────────────────────────────────────────────────────
  const reviewRows: Prisma.ReviewCreateManyInput[] = reviewPlans.map((plan, r) => {
    const createdAt = new Date(plan.placedAt.getTime() + 3 * 86_400_000);
    return {
      id: `${SEED_PREFIX}review_${pad(r + 1, 3)}`,
      orgId: buyerOrgRows[plan.buyerIndex]?.id ?? "",
      supplierOrgId: supplierOrgRows[plan.supplierIndex]?.id ?? "",
      authorUserId: `${SEED_PREFIX}user_${pad(plan.buyerIndex + 1, 2)}`,
      listingId: plan.listingId,
      orderId: `${SEED_PREFIX}order_${pad(plan.orderIndex + 1, 3)}`,
      qualityRating: 3 + (r % 3),
      communicationRating: 4 + (r % 2),
      onTimeRating: 2 + (r % 4),
      packagingAccuracyRating: 3 + ((r + 2) % 3),
      title: REVIEW_TITLES[r % REVIEW_TITLES.length],
      body: REVIEW_BODIES[r % REVIEW_BODIES.length],
      supplierResponse:
        r % 5 === 0 ? "Thanks for the detailed feedback — glad the run met spec." : null,
      supplierRespondedAt: r % 5 === 0 ? new Date(createdAt.getTime() + 86_400_000) : null,
      createdAt,
      updatedAt: createdAt,
    };
  });

  // ── Persist (single transaction: wipe + recreate, atomically) ─────────────
  await client.$transaction(async (tx) => {
    wipeSeededRows(tx);
    await tx.category.createMany({ data: categoryRows });
    await tx.organization.createMany({ data: supplierOrgRows });
    await tx.organization.createMany({ data: buyerOrgRows });
    await tx.supplierProfile.createMany({ data: supplierProfileRows });
    await tx.plant.createMany({ data: plantRows });
    await tx.user.createMany({ data: userRows });
    await tx.orgMembership.createMany({ data: membershipRows });
    await tx.listing.createMany({ data: listingRows });
    await tx.moqPriceTier.createMany({ data: moqTierRows });
    await tx.leadTimeRule.createMany({ data: leadTimeRows });
    await tx.capability.createMany({ data: capabilityRows });
    await tx.order.createMany({ data: orderRows });
    await tx.subOrder.createMany({ data: subOrderRows });
    await tx.orderLine.createMany({ data: orderLineRows });
    await tx.review.createMany({ data: reviewRows });
  });

  return {
    categories: categoryRows.length,
    supplierOrgs: supplierOrgRows.length,
    buyerOrgs: buyerOrgRows.length,
    users: userRows.length,
    supplierProfiles: supplierProfileRows.length,
    plants: plantRows.length,
    capabilities: capabilityRows.length,
    listings: listingRows.length,
    moqTiers: moqTierRows.length,
    leadTimeRules: leadTimeRows.length,
    orders: orderRows.length,
    subOrders: subOrderRows.length,
    orderLines: orderLineRows.length,
    reviews: reviewRows.length,
  };
}
