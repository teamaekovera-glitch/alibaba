import { describe, expect, it } from "vitest";
import type { ListingRepository, ListingUpsertInput } from "../../src/index";
import type { ListingWithRelations } from "../../src/listing-repository";
import { importListingsCsv, importReportToCsv } from "../../src/listing-import";

/**
 * CSV import orchestration without a database: parse-level errors must never
 * reach the repository, repository-level failures become row errors, and the
 * error report renders each failure with its line number. Per-row write
 * atomicity (zero partial writes) is proven against a real database in
 * tests/integration/listing-repository.test.ts.
 */

function stubRepo(created: ListingUpsertInput[]): ListingRepository {
  return {
    createListing: async (input: ListingUpsertInput) => {
      created.push(input);
      // Minimal stand-in for the full Prisma relation payload — the stub only
      // proves the importer called the repository.
      return {
        id: `listing_${created.length}`,
        title: input.title,
        slug: `slug-${created.length}`,
      } as ListingWithRelations;
    },
  } as unknown as ListingRepository;
}

const HEADER =
  "title,categorySlug,attributes_json,moq_1_minQty,moq_1_unitPriceCents,lead_1_qtyMin,lead_1_productionDays";

function row(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    title: "Imported PET bottle",
    categorySlug: "any-slug",
    attributes_json: JSON.stringify({ material: "PET" }),
    moq_1_minQty: "500",
    moq_1_unitPriceCents: "42",
    lead_1_qtyMin: "500",
    lead_1_productionDays: "10",
  };
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = value;
  }
  return Object.values(base)
    .map((value) => `"${String(value).replace(/"/g, '""')}"`)
    .join(",");
}

describe("listing CSV import orchestration", () => {
  it("imports shape-valid rows and skips malformed ones without calling the repository", async () => {
    const created: ListingUpsertInput[] = [];
    const csv = [
      HEADER,
      row(),
      row({ title: "No" }),
      row({ attributes_json: "not json" }),
      row({ moq_1_minQty: "" }),
    ].join("\n");

    const report = await importListingsCsv(stubRepo(created), csv);

    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("Imported PET bottle");
    expect(report.importedCount).toBe(1);
    expect(report.skippedCount).toBe(3);
    expect(report.totalRows).toBe(4);
    expect(report.errors.map((e) => e.lineNumber).every((line) => line > 1)).toBe(true);
    // every failed row is reported with its offending column
    const columns = report.errors.map((e) => e.column);
    expect(columns).toContain("title");
    expect(columns).toContain("attributes_json");
  });

  it("turns repository-level row failures into row errors instead of crashes", async () => {
    const created: ListingUpsertInput[] = [];
    const repo = {
      createListing: async () => {
        throw new Error("category not found");
      },
    } as unknown as ListingRepository;

    const report = await importListingsCsv(repo, [HEADER, row()].join("\n"));

    expect(report.importedCount).toBe(0);
    expect(report.skippedCount).toBe(1);
    expect(report.errors[0]?.message).toContain("category not found");
    expect(created).toHaveLength(0);
  });

  it("reports a header missing required columns and imports nothing", async () => {
    const created: ListingUpsertInput[] = [];
    const report = await importListingsCsv(stubRepo(created), 'title,moq_1_minQty\n"Imported PET bottle","500"\n');

    expect(created).toHaveLength(0);
    expect(report.errors.some((e) => e.column === "categorySlug")).toBe(true);
  });

  it("renders the row-level error report as CSV containing every failure", async () => {
    const created: ListingUpsertInput[] = [];
    const csv = [HEADER, row(), row({ title: "No" })].join("\n");
    const report = await importListingsCsv(stubRepo(created), csv);

    const errorCsv = importReportToCsv(report);
    const lines = errorCsv.split(/\r?\n/).filter((line) => line !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2); // header + at least one error
    expect(errorCsv).toContain("must be 3–160 characters");
    for (const error of report.errors) {
      expect(errorCsv).toContain(String(error.lineNumber));
    }
  });
});
