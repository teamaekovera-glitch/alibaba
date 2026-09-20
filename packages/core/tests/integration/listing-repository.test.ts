import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  TOP_LEVEL_CATEGORY_SLUGS,
  attributeSetForSlug,
  categoryDefinition,
  flattenTaxonomy,
  generateListingAttributes,
  mulberry32,
} from "@packsource/db";
import {
  IncompleteListingError,
  ListingNotEditableError,
  ListingRepository,
  PermissionDeniedError,
  RecordNotFoundError,
  SpecExtractionUnconfirmedError,
  extractSpecSuggestions,
  importListingsCsv,
  type AuthContext,
} from "../../src/index";

/**
 * Listing management against a real database (self-sufficient in CI):
 *
 *  1. permission gates — cross-org and wrong-role create/edit/submit are
 *     refused, staff-only moderation is refused to suppliers,
 *  2. the lifecycle state machine end-to-end with audit events on every
 *     transition and publish-only-after-submit enforcement,
 *  3. the spec-sheet extraction flow — EXTRACTED suggestions block publish
 *     until a human confirms, applying suggestions edits the draft only,
 *  4. bulk CSV import with malformed rows — every row commits or rolls back
 *     atomically; a failed row never partially writes.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const SLUG = TOP_LEVEL_CATEGORY_SLUGS[0] as string;

function repo(auth: AuthContext): ListingRepository {
  return new ListingRepository(prisma, auth);
}

function validInput(title: string) {
  return {
    title,
    categorySlug: SLUG,
    attributes: generateListingAttributes(mulberry32(11), SLUG),
    moqTiers: [
      { minQty: 500, unitPriceCents: 42 },
      { minQty: 1000, unitPriceCents: 39 },
    ],
    leadTimeRules: [{ qtyMin: 500, qtyMax: null, productionDays: 10 }],
  };
}

let salesA!: AuthContext;
let opsA!: AuthContext;
let buyerA!: AuthContext;
let salesB!: AuthContext;
let staff!: AuthContext;
let orgAId!: string;

// Migrations live in @packsource/db — run its prisma CLI there.
beforeAll(() => {
  execSync("npx prisma migrate deploy", {
    cwd: dbPkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return seed();
}, 30_000);

afterAll(async () => {
  // Leave the shared database clean for the next serialized suite: every
  // integration file seeds itself, so an empty migrated schema is the
  // neutral handoff state (plain-id fixture rows would otherwise survive
  // the seed's seed_-prefixed wipe and collide on Category.slug).
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "Organization", "User", "AuditLog", "Category" CASCADE`);
  await prisma.$disconnect();
});

async function seed(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "Organization", "User", "AuditLog", "Category" CASCADE`);
  await prisma.category.createMany({
    data: flattenTaxonomy().map(({ slug, name }) => ({
      slug,
      name,
      attributeSet: categoryDefinition(slug)?.attributeSet ?? {},
    })),
  });

  const [salesUserA, opsUserA, buyerUserA, salesUserB, staffUser] = await Promise.all([
    prisma.user.create({ data: { email: "sales-a@listing-test.example" } }),
    prisma.user.create({ data: { email: "ops-a@listing-test.example" } }),
    prisma.user.create({ data: { email: "buyer-a@listing-test.example" } }),
    prisma.user.create({ data: { email: "sales-b@listing-test.example" } }),
    prisma.user.create({ data: { email: "staff@listing-test.example" } }),
  ]);

  const orgA = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Listing Test Supplier A",
      slug: "listing-test-a",
      members: { create: { userId: salesUserA.id, role: "SUPPLIER_SALES" } },
    },
  });
  await prisma.orgMembership.create({ data: { orgId: orgA.id, userId: opsUserA.id, role: "SUPPLIER_OPS" } });
  await prisma.orgMembership.create({ data: { orgId: orgA.id, userId: buyerUserA.id, role: "BUYER" } });
  const orgB = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Listing Test Supplier B",
      slug: "listing-test-b",
      members: { create: { userId: salesUserB.id, role: "SUPPLIER_SALES" } },
    },
  });
  const platform = await prisma.organization.create({
    data: { type: "PLATFORM", name: "AEKOVERA", slug: "listing-test-platform" },
  });

  orgAId = orgA.id;
  salesA = { userId: salesUserA.id, orgId: orgA.id, role: "SUPPLIER_SALES" };
  opsA = { userId: opsUserA.id, orgId: orgA.id, role: "SUPPLIER_OPS" };
  buyerA = { userId: buyerUserA.id, orgId: orgA.id, role: "BUYER" };
  salesB = { userId: salesUserB.id, orgId: orgB.id, role: "SUPPLIER_SALES" };
  staff = { userId: staffUser.id, orgId: platform.id, role: "AEKOVERA_STAFF" };
}

async function auditActions(listingId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: "Listing", entityId: listingId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => row.action);
}

describe("listing permission gates", () => {
  it("lets a SUPPLIER_SALES member of the owning org create and read a draft", async () => {
    const listing = await repo(salesA).createListing(validInput("Gate test bottle"));
    expect(listing.status).toBe("DRAFT");

    const read = await repo(salesA).listing(listing.id);
    expect(read.orgId).toBe(orgAId);
  });

  it("blocks create for a wrong role in the same org", async () => {
    await expect(repo(opsA).createListing(validInput("Ops should fail"))).rejects.toThrow(PermissionDeniedError);
    await expect(repo(buyerA).createListing(validInput("Buyer should fail"))).rejects.toThrow(PermissionDeniedError);
  });

  it("blocks cross-org reads and mutations even with a known foreign id", async () => {
    const listing = await repo(salesA).createListing(validInput("Cross-org target"));

    await expect(repo(salesB).listing(listing.id)).rejects.toThrow(RecordNotFoundError);
    await expect(
      repo(salesB).updateListingDraft(listing.id, { title: "Hijacked title" }),
    ).rejects.toThrow(RecordNotFoundError);
    await expect(repo(salesB).submitForReview(listing.id)).rejects.toThrow(RecordNotFoundError);
    await expect(repo(salesB).unpublish(listing.id)).rejects.toThrow(RecordNotFoundError);

    const stillOwned = await repo(salesA).listing(listing.id);
    expect(stillOwned.title).toBe("Cross-org target");
  });
});

describe("listing lifecycle state machine", () => {
  it("enforces draft-only edits and the full legal path with audit events", async () => {
    const repoA = repo(salesA);
    const listing = await repoA.createListing(validInput("Lifecycle bottle"));
    expect(await auditActions(listing.id)).toEqual(["listing.create"]);

    const updated = await repoA.updateListingDraft(listing.id, { description: "Updated while draft" });
    expect(updated.description).toBe("Updated while draft");

    const submitted = await repoA.submitForReview(listing.id);
    expect(submitted.status).toBe("PENDING_REVIEW");

    // edits are draft-only: no edit path once submitted
    await expect(
      repoA.updateListingDraft(listing.id, { title: "Edited while pending" }),
    ).rejects.toThrow(ListingNotEditableError);

    // publish-only-after-submit is legal here, but publishing is staff-only
    await expect(repoA.publish(listing.id)).rejects.toThrow(PermissionDeniedError);

    const published = await repo(staff).publish(listing.id);
    expect(published.status).toBe("LIVE");
    expect(published.publishedAt).not.toBeNull();

    // supplier-side pause/resume cycle
    const paused = await repoA.unpublish(listing.id);
    expect(paused.status).toBe("PAUSED");
    const liveAgain = await repoA.republish(listing.id);
    expect(liveAgain.status).toBe("LIVE");

    const actions = await auditActions(listing.id);
    expect(actions).toEqual([
      "listing.create",
      "listing.update",
      "listing.submit",
      "listing.publish",
      "listing.unpublish",
      "listing.republish",
    ]);
  });

  it("allows staff to reject a pending listing and the supplier to revise it", async () => {
    const repoA = repo(salesA);
    const listing = await repoA.createListing(validInput("Reject path bottle"));
    await repoA.submitForReview(listing.id);

    // suppliers cannot reject their own submission
    await expect(repoA.reject(listing.id, "nope")).rejects.toThrow(PermissionDeniedError);

    const rejected = await repo(staff).reject(listing.id, "images unreadable");
    expect(rejected.status).toBe("REJECTED");

    // the only legal edge out of REJECTED
    await expect(repoA.unpublish(listing.id)).rejects.toThrow();
    const revised = await repoA.revise(listing.id);
    expect(revised.status).toBe("DRAFT");
    expect((await auditActions(listing.id)).at(-1)).toBe("listing.revise");
  });

  it("blocks submit when the draft is incomplete", async () => {
    const repoA = repo(salesA);
    const input = validInput("Incomplete bottle");
    delete (input as { moqTiers?: unknown }).moqTiers;
    const listing = await repoA.createListing(input);
    await expect(repoA.submitForReview(listing.id)).rejects.toThrow(IncompleteListingError);
  });

  it("keeps every transition inside the org for supplier roles", async () => {
    const listing = await repo(salesA).createListing(validInput("Scope bottle"));
    for (const [actor, expected] of [
      [salesB, RecordNotFoundError],
      [opsA, PermissionDeniedError],
    ] as const) {
      await expect(repo(actor).submitForReview(listing.id)).rejects.toThrow(expected);
    }
  });
});

describe("spec-sheet extraction flow", () => {
  it("blocks publish on EXTRACTED sheets until a human confirms, then allows it", async () => {
    const repoA = repo(salesA);
    const set = attributeSetForSlug(SLUG);
    if (!set) throw new Error(`attribute set missing for ${SLUG}`);
    const category = categoryDefinition(SLUG);
    if (!category) throw new Error(`category definition missing for ${SLUG}`);

    const specLines: string[] = [];
    for (const definition of set.attributes) {
      if (definition.type === "number" || definition.type === "integer") {
        specLines.push(`${definition.label}: 42 ${definition.unit ?? ""}`.trim());
      } else if (definition.type === "enum") {
        const option = definition.options?.[0];
        if (option !== undefined) specLines.push(`${definition.label}: ${option}`);
      } else if (definition.type === "boolean") {
        specLines.push(`${definition.label}: yes`);
      } else {
        specLines.push(`${definition.label}: high gloss`);
      }
    }

    const listing = await repoA.createListing(validInput("Extraction flow bottle"));
    const sheet = await repoA.addSpecSheet(listing.id, {
      fileId: "spec-sheets/extraction-flow-1",
      title: "extraction-flow.txt",
    });
    const payload = extractSpecSuggestions(specLines.join("\n"), set);
    await repoA.recordSpecExtraction(listing.id, sheet.id, { ...payload, reasoningModel: "mock-reasoning-v1" });

    let current = await repoA.listing(listing.id);
    expect(current.specSheets[0]?.extractionStatus).toBe("EXTRACTED");

    await repoA.submitForReview(listing.id);
    await expect(repo(staff).publish(listing.id)).rejects.toThrow(SpecExtractionUnconfirmedError);

    // withdrawal returns the listing to the supplier for review + confirmation
    await repoA.withdraw(listing.id);
    await repoA.applySpecSuggestions(listing.id, sheet.id);
    expect((await auditActions(listing.id)).at(-1)).toBe("listing.spec_sheet.apply");

    await repoA.confirmSpecSheet(listing.id, sheet.id);
    current = await repoA.listing(listing.id);
    expect(current.specSheets[0]?.extractionStatus).toBe("CONFIRMED");
    expect(current.status).toBe("DRAFT");

    await repoA.submitForReview(listing.id);
    const published = await repo(staff).publish(listing.id);
    expect(published.status).toBe("LIVE");

    const actions = await auditActions(listing.id);
    expect(actions).toContain("listing.spec_sheet.extract");
    expect(actions).toContain("listing.spec_sheet.confirm");
    expect(actions).toContain("listing.publish");
  });
});

describe("bulk CSV import", () => {
  it("imports valid rows fully, skips malformed rows, and never partially writes", async () => {
    const repoA = repo(salesA);
    const attributesJson = JSON.stringify(generateListingAttributes(mulberry32(13), SLUG));
    const header =
      "title,categorySlug,attributes_json,moq_1_minQty,moq_1_unitPriceCents,moq_2_minQty,moq_2_unitPriceCents,lead_1_qtyMin,lead_1_productionDays";
    // RFC-4180: embedded quotes (the JSON column) are doubled inside the field
    const csvField = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const validRow = (title: string) =>
      [csvField(title), csvField(SLUG), csvField(attributesJson), "500", "42", "1000", "39", "500", "10"].join(",");
    const csv = [
      header,
      validRow("Imported bottle A"),
      validRow("Imported bottle B"),
      // malformed: unparseable attributes JSON
      [csvField("Broken attributes row"), csvField(SLUG), csvField("not json"), "500", "42", "1000", "39", "500", "10"].join(","),
      // shape-valid but repository-invalid: unknown category
      [csvField("Broken category row"), csvField("no-such-category"), csvField(attributesJson), "500", "42", "1000", "39", "500", "10"].join(","),
      // malformed: title too short
      [csvField("No"), csvField(SLUG), csvField(attributesJson), "500", "42", "1000", "39", "500", "10"].join(","),
    ].join("\n");

    const report = await importListingsCsv(repoA, csv);

    expect(report.importedCount).toBe(2);
    expect(report.skippedCount).toBe(3);
    expect(report.totalRows).toBe(5);

    // valid rows landed with their complete ladders and lead times
    const importedIds = report.imported.map((row) => row.id);
    const importedListings = await prisma.listing.findMany({
      where: { id: { in: importedIds } },
      include: { moqTiers: true, leadTimes: true },
    });
    expect(importedListings).toHaveLength(2);
    for (const listing of importedListings) {
      expect(listing.orgId).toBe(orgAId);
      expect(listing.status).toBe("DRAFT");
      expect(listing.moqTiers).toHaveLength(2);
      expect(listing.leadTimes).toHaveLength(1);
    }

    // malformed rows wrote nothing at all — no listing, no orphan children
    const brokenCount = await prisma.listing.count({
      where: { orgId: orgAId, title: { in: ["Broken attributes row", "Broken category row", "No"] } },
    });
    expect(brokenCount).toBe(0);
    const orphanTiers = await prisma.moqPriceTier.count({
      where: { listing: { title: { startsWith: "Broken" } } },
    });
    expect(orphanTiers).toBe(0);
    const orphanLeadTimes = await prisma.leadTimeRule.count({
      where: { listing: { title: { startsWith: "Broken" } } },
    });
    expect(orphanLeadTimes).toBe(0);

    // the import itself is audited
    expect((await auditActions(importedIds[0] as string)).at(-1)).toBe("listing.create");
  });
});
