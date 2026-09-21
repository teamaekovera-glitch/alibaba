/**
 * Pure mapping from parsed Platform Ready CSV records to importable
 * PlatformSupplier rows: column contract enforcement, value parsing, slug
 * assignment, and classification. No database, no I/O — unit-testable.
 */

import { parseCsv } from "../importer/parse-csv";
import { classifySupplier } from "./classify";
import { supplierSlug } from "./slug";
import { isDiscoveryCategorySlug } from "./taxonomy";

/** Exact source column names, in the fixture's header order. */
export const PLATFORM_SUPPLIER_COLUMNS = [
  "Master ID",
  "Company Name",
  "DBA",
  "Supplier Type",
  "Specialty",
  "Products",
  "Description",
  "Primary Email",
  "General Email",
  "Phone",
  "Website",
  "LinkedIn",
  "Street Address",
  "City",
  "State",
  "ZIP",
  "Country",
  "Certifications",
  "Year Founded",
  "Company Size",
  "Tier",
  "AI Confidence",
  "Website Newly Discovered",
  "Judged At",
] as const;

export interface PlatformSupplierRowInput {
  slug: string;
  name: string;
  dba: string | null;
  supplierTypes: string[];
  specialty: string | null;
  products: string | null;
  description: string | null;
  primaryEmail: string | null;
  generalEmail: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  certifications: string[];
  yearFounded: string | null;
  companySize: string | null;
  tier: number | null;
  aiConfidence: number | null;
  primaryCategory: string;
  categorySlugs: string[];
}

export interface PlatformRowError {
  lineNumber: number;
  message: string;
}

function cell(fields: string[], header: string[], columnName: string): string | null {
  const index = header.indexOf(columnName);
  if (index < 0) return null;
  const value = (fields[index] ?? "").trim();
  return value === "" ? null : value;
}

/** Split a delimited source value into a clean, deduped list. */
export function splitList(value: string | null, separators: string[]): string[] {
  if (value === null) return [];
  const parts = value
    .split(new RegExp(separators.join("|")))
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    result.push(part);
  }
  return result;
}

function optionalNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Honest stand-in name for records with no company name and no DBA — the
 * location is all the source row says. Deterministic per record.
 */
function syntheticName(city: string | null, state: string | null): string | null {
  const place = [city, state].filter((part) => part !== null).join(", ");
  return place === "" ? null : `Unnamed Supplier (${place})`;
}

/**
 * Map parsed CSV text to classified rows. Records without a Company Name fall
 * back to DBA, then a location-derived stand-in, so every source row lands;
 * rows with no name material at all are reported as errors and skipped. Every
 * mapped row carries a non-empty primaryCategory from the classifier
 * (zero-match → other-general).
 */
export function readPlatformSupplierRows(csvText: string): {
  rows: PlatformSupplierRowInput[];
  errors: PlatformRowError[];
} {
  const csv = parseCsv(csvText);
  const header = csv.header;

  const missing = PLATFORM_SUPPLIER_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [{ lineNumber: 1, message: `missing required columns: ${missing.join(", ")}` }],
    };
  }

  const rows: PlatformSupplierRowInput[] = [];
  const errors: PlatformRowError[] = [];
  const taken = new Set<string>();

  for (const record of csv.rows) {
    const state = cell(record.fields, header, "State");
    const city = cell(record.fields, header, "City");
    const dba = cell(record.fields, header, "DBA");
    // Name fallback chain keeps the import total at the full 7,658 records:
    // the 4 source rows without a Company Name still have a DBA (3) or at
    // least a location, and a record must land somewhere to stay reachable.
    const name = cell(record.fields, header, "Company Name") ?? dba ?? syntheticName(city, state);
    if (name === null) {
      errors.push({
        lineNumber: record.lineNumber,
        message: "no Company Name, DBA, or location to name the record",
      });
      continue;
    }

    const slug = supplierSlug(name, state, taken);
    taken.add(slug);

    const supplierTypes = splitList(cell(record.fields, header, "Supplier Type"), ["\\|"]);
    const classification = classifySupplier({
      specialty: cell(record.fields, header, "Specialty"),
      products: cell(record.fields, header, "Products"),
      description: cell(record.fields, header, "Description"),
      supplierTypes,
    });

    if (!isDiscoveryCategorySlug(classification.primaryCategory)) {
      errors.push({
        lineNumber: record.lineNumber,
        message: `classifier returned unknown category "${classification.primaryCategory}"`,
      });
      continue;
    }

    rows.push({
      slug,
      name,
      dba: name === dba ? null : dba,
      supplierTypes,
      specialty: cell(record.fields, header, "Specialty"),
      products: cell(record.fields, header, "Products"),
      description: cell(record.fields, header, "Description"),
      primaryEmail: cell(record.fields, header, "Primary Email"),
      generalEmail: cell(record.fields, header, "General Email"),
      phone: cell(record.fields, header, "Phone"),
      website: cell(record.fields, header, "Website"),
      linkedin: cell(record.fields, header, "LinkedIn"),
      city,
      state,
      zip: cell(record.fields, header, "ZIP"),
      country: cell(record.fields, header, "Country"),
      // Source mixes ";" and "," separators between certifications.
      certifications: splitList(cell(record.fields, header, "Certifications"), [";", ","]),
      yearFounded: cell(record.fields, header, "Year Founded"),
      companySize: cell(record.fields, header, "Company Size"),
      tier: optionalNumber(cell(record.fields, header, "Tier")),
      aiConfidence: optionalNumber(cell(record.fields, header, "AI Confidence")),
      primaryCategory: classification.primaryCategory,
      categorySlugs: classification.categorySlugs,
    });
  }

  return { rows, errors };
}
