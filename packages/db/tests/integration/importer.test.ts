import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildMergeReportCsv, importSuppliersCsv, type ImportSummary } from "../../src/index";

/**
 * Importer integration against the pgvector/pg16 service container, using the
 * committed fixture: 500 data rows, of which 10 are engineered near-duplicates
 * of earlier rows (spec verification table: the fixture imports to at most 491
 * orgs, emits a merge report, and leaves every imported profile UNVERIFIED).
 *
 * The importer does not wipe (writes are idempotent by deterministic id), so
 * the setup clears any previous imported_* rows first, children before
 * parents.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const FIXTURE_PATH = path.join(pkgRoot, "fixtures", "importer", "sample-500.csv");

async function clearImportedRows(): Promise<void> {
  await prisma.capability.deleteMany({ where: { id: { startsWith: "imported_" } } });
  await prisma.plant.deleteMany({ where: { id: { startsWith: "imported_" } } });
  await prisma.supplierProfile.deleteMany({ where: { id: { startsWith: "imported_" } } });
  await prisma.organization.deleteMany({ where: { id: { startsWith: "imported_" } } });
}

beforeAll(() => {
  execSync("npx prisma migrate deploy", {
    cwd: pkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return clearImportedRows();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("supplier CSV importer (500-row fixture)", () => {
  let summary: ImportSummary;

  it("imports the fixture into at most 491 orgs", async () => {
    const csvText = readFileSync(FIXTURE_PATH, "utf8");
    summary = await importSuppliersCsv(prisma, csvText);

    expect(summary.inputRowCount).toBe(500);
    expect(summary.errorRows).toEqual([]);
    expect(summary.importedOrgCount).toBeLessThanOrEqual(491);
    // Deterministic accounting: every non-merged row becomes exactly one org.
    expect(summary.importedOrgCount).toBe(500 - summary.mergedRowCount);
    expect(summary.mergedRowCount).toBeGreaterThanOrEqual(1);
    // The engineered near-duplicates were caught as merge or review decisions.
    expect(summary.decisions.length).toBe(summary.mergedRowCount + summary.reviewRowCount);
    for (const decision of summary.decisions) {
      expect(decision.score).toBeGreaterThanOrEqual(0.7);
      expect(decision.score).toBeLessThanOrEqual(1);
      expect(decision.duplicateLineNumber).toBeGreaterThan(1);
    }
  });

  it("emits a merge report CSV with one row per decision plus a header", () => {
    const report = buildMergeReportCsv(summary.decisions);
    const lines = report.trimEnd().split(/\r?\n/);
    expect(lines.length).toBe(summary.decisions.length + 1);
    expect(lines[0]).toContain("decision");
    expect(lines[0]).toContain("duplicate_name");
    for (const decision of summary.decisions) {
      expect(report).toContain(decision.decision);
      expect(report).toContain(decision.duplicateName);
    }
  });

  it("leaves every imported profile hard-set to UNVERIFIED", async () => {
    const [orgCount, profileCount, nonUnverified] = await Promise.all([
      prisma.organization.count({ where: { id: { startsWith: "imported_org_line_" } } }),
      prisma.supplierProfile.count({ where: { id: { startsWith: "imported_profile_line_" } } }),
      prisma.supplierProfile.count({
        where: {
          id: { startsWith: "imported_profile_line_" },
          verificationStatus: { not: "UNVERIFIED" },
        },
      }),
    ]);
    expect(orgCount).toBe(summary.importedOrgCount);
    expect(profileCount).toBe(summary.importedOrgCount);
    expect(nonUnverified).toBe(0);

    // Every imported org traces back to a CSV line and carries a primary plant.
    const plants = await prisma.plant.findMany({
      where: { id: { startsWith: "imported_plant_line_" } },
      select: { orgId: true, isPrimary: true },
    });
    expect(plants.length).toBe(summary.importedOrgCount);
    for (const plant of plants) {
      expect(plant.isPrimary).toBe(true);
      expect(plant.orgId).toMatch(/^imported_org_line_\d+$/);
    }
  });
});
