import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPlatformSupplierRows } from "../../src/discovery/import-rows";
import { OTHER_GENERAL_SLUG } from "../../src/discovery/taxonomy";

/** The real fixture's header — synthetic rows ride on the actual column order. */
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/platform-suppliers/platform-ready-20260817.csv",
);
const firstLine = readFileSync(FIXTURE, "utf8").split(/\r\n/, 1)[0];
if (!firstLine) throw new Error("fixture CSV has no header row");
const HEADER = firstLine;

/** Build a CSV of one or more rows over the fixture's real header. */
function csvWithRows(...rowFields: Record<string, string>[]): string {
  const lines = rowFields.map((fields) =>
    HEADER.split(",")
      .map((quoted) => {
        const name = quoted.replace(/^"|"$/g, "");
        const value = fields[name] ?? "";
        return `"${value.replace(/"/g, '""')}"`;
      })
      .join(","),
  );
  return `${HEADER}\r\n${lines.join("\r\n")}\r\n`;
}

describe("readPlatformSupplierRows — name fallback chain", () => {
  it("uses the DBA when Company Name is empty (real Cleanlogic pattern)", () => {
    const { rows, errors } = readPlatformSupplierRows(
      csvWithRows({
        DBA: "Cleanlogic",
        "Supplier Type": "Private Label Manufacturer",
        Specialty: "bath and body care products",
        City: "Audubon",
        State: "PA",
      }),
    );
    expect(errors).toEqual([]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("Cleanlogic");
    // The DBA is the whole name — dba null avoids rendering it twice.
    expect(rows[0]?.dba).toBeNull();
  });

  it("synthesizes a location-based name when name and DBA are both empty", () => {
    const { rows, errors } = readPlatformSupplierRows(
      csvWithRows({ City: "Peru", State: "IL", "Supplier Type": "Ingredient Supplier" }),
    );
    expect(errors).toEqual([]);
    expect(rows[0]?.name).toBe("Unnamed Supplier (Peru, IL)");
  });

  it("errors a row with content but no name material at all", () => {
    // Fully-empty rows are dropped by the CSV parser itself; a row that carries
    // data but no name, DBA, or location is the real error case.
    const { rows, errors } = readPlatformSupplierRows(
      csvWithRows({ "Supplier Type": "Ingredient Supplier" }),
    );
    expect(rows).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain("no Company Name, DBA, or location");
  });
});

describe("readPlatformSupplierRows — field mapping", () => {
  it("splits pipe-delimited supplier types", () => {
    const { rows } = readPlatformSupplierRows(
      csvWithRows({
        "Company Name": "Alpha Foods",
        "Supplier Type": "Co-Packer | Food Manufacturer / Brand",
      }),
    );
    expect(rows[0]?.supplierTypes).toEqual(["Co-Packer", "Food Manufacturer / Brand"]);
  });

  it("splits certifications on both ; and , separators", () => {
    const { rows } = readPlatformSupplierRows(
      csvWithRows({
        "Company Name": "Beta Baking",
        Certifications: "SQF; USDA Organic, Non-GMO Project",
      }),
    );
    expect(rows[0]?.certifications).toEqual(["SQF", "USDA Organic", "Non-GMO Project"]);
  });

  it("dedupes slugs with state then ordinal", () => {
    const csv = csvWithRows(
      { "Company Name": "Acme Foods", State: "TX" },
      { "Company Name": "Acme Foods", State: "TX" },
      { "Company Name": "Acme Foods", State: "CA" },
    );
    const { rows } = readPlatformSupplierRows(csv);
    expect(rows.map((row) => row.slug)).toEqual(["acme-foods", "acme-foods-tx", "acme-foods-ca"]);
  });

  it("parses tier and confidence as numbers, tolerating blanks", () => {
    const { rows } = readPlatformSupplierRows(
      csvWithRows({ "Company Name": "Gamma Snacks", Tier: "2", "AI Confidence": "0.8" }),
    );
    expect(rows[0]?.tier).toBe(2);
    expect(rows[0]?.aiConfidence).toBe(0.8);

    const blank = readPlatformSupplierRows(csvWithRows({ "Company Name": "Delta Snacks" }));
    expect(blank.rows[0]?.tier).toBeNull();
    expect(blank.rows[0]?.aiConfidence).toBeNull();
  });

  it("sends a zero-signal row to other-general and keeps it reachable", () => {
    const { rows } = readPlatformSupplierRows(
      csvWithRows({ "Company Name": "Epsilon Holding", City: "Peru", State: "IL" }),
    );
    expect(rows[0]?.primaryCategory).toBe(OTHER_GENERAL_SLUG);
  });
});
