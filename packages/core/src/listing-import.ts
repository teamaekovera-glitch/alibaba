/**
 * Bulk listing import for suppliers (spec: Supplier console → Listing
 * management → bulk import). Reuses the PR #5 migration importer's patterns —
 * the RFC-4180 parser with line-number tracing and row-level error reports —
 * but writes through ListingRepository so every row gets the same permission
 * checks, attribute validation, audit events, and per-row transactional
 * atomicity as an individual create.
 *
 * Atomicity contract: a row either imports completely (listing + MOQ tiers +
 * lead-time bands + variants, one transaction) or not at all. A malformed row
 * never partially writes, and a database failure on one row rolls back only
 * that row — it never blocks or corrupts the other rows.
 *
 * Column contract (documented for the UI and the error report):
 *
 *   title                    required — listing title (3–160 chars)
 *   categorySlug             required — one of the nine taxonomy slugs
 *   description              optional — free text (≤ 5000 chars)
 *   attributes_json          optional — JSON object keyed by attribute key;
 *                              validated against the category's attribute set
 *   stockLevel               optional — OUT_OF_STOCK | LOW | IN_STOCK |
 *                              MADE_TO_ORDER
 *   capacityUnitsPerWeek     optional — non-negative integer
 *   moq_N_minQty             required for N=1 — tier minimum quantity
 *   moq_N_unitPriceCents     required for N=1 — integer cents (tier 1 price)
 *   …moq_2_* … moq_5_*       optional — further ladder tiers
 *   lead_1_qtyMin            required — band minimum quantity
 *   lead_1_qtyMax            optional — empty = open-ended above qtyMin
 *   lead_1_productionDays    required — integer days 1–365
 *   …lead_2_* … lead_3_*     optional — further non-overlapping bands
 *   variant_N_sku            optional — up to 5 variants
 *   variant_N_unitPriceCents optional — integer cents
 *
 * Unknown columns are ignored so suppliers can keep internal bookkeeping
 * columns in their sheets.
 */
import { parseCsv } from "@packsource/db";
import type { ListingRepository } from "./listing-repository";
import type { ListingUpsertInput } from "./listing-input";
import { ListingInputError } from "./listing-input";

/** One CSV column of the contract, for UI rendering and docs. */
export interface ListingImportColumn {
  name: string;
  required: boolean;
  description: string;
  example: string;
}

/** Contract metadata rendered by the bulk-import screen. */
export const LISTING_IMPORT_COLUMNS: readonly ListingImportColumn[] = [
  { name: "title", required: true, description: "Listing title (3–160 characters)", example: "256ml PET juice bottle" },
  { name: "categorySlug", required: true, description: "One of the nine packaging category slugs", example: "bottles" },
  { name: "description", required: false, description: "Free-text description (≤ 5000 characters)", example: "Clear PET bottle for cold-fill juice" },
  { name: "attributes_json", required: false, description: "JSON object of attribute values keyed by attribute key", example: '{"material":"PET","volumeMl":256}' },
  { name: "stockLevel", required: false, description: "OUT_OF_STOCK, LOW, IN_STOCK, or MADE_TO_ORDER", example: "IN_STOCK" },
  { name: "capacityUnitsPerWeek", required: false, description: "Weekly production capacity, integer", example: "50000" },
  { name: "moq_1_minQty", required: true, description: "Lowest MOQ tier minimum quantity", example: "1000" },
  { name: "moq_1_unitPriceCents", required: true, description: "Lowest tier unit price in integer cents", example: "42" },
  { name: "moq_2_minQty", required: false, description: "Second tier minimum quantity", example: "5000" },
  { name: "moq_2_unitPriceCents", required: false, description: "Second tier unit price in cents", example: "38" },
  { name: "lead_1_qtyMin", required: true, description: "Lead-time band minimum quantity", example: "1000" },
  { name: "lead_1_qtyMax", required: false, description: "Band maximum quantity — leave empty for open-ended", example: "4999" },
  { name: "lead_1_productionDays", required: true, description: "Production days for the band (1–365)", example: "14" },
  { name: "variant_1_sku", required: false, description: "First variant SKU", example: "PET256-NAT" },
  { name: "variant_1_unitPriceCents", required: false, description: "First variant unit price in cents", example: "44" },
];

const MAX_MOQ_TIERS = 5;
const MAX_LEAD_BANDS = 3;
const MAX_VARIANTS = 5;

/** One validation/import error, traceable to its CSV line and column. */
export interface ListingImportError {
  lineNumber: number;
  column: string | null;
  message: string;
}

/** A parsed, shape-valid row ready for repository validation. */
interface ParsedRow {
  lineNumber: number;
  input: ListingUpsertInput;
}

export interface ListingImportReport {
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  errors: ListingImportError[];
  imported: { lineNumber: number; id: string; title: string; slug: string }[];
}

interface CsvRow {
  lineNumber: number;
  fields: string[];
}

function field(row: CsvRow, header: string[], name: string): string | null {
  const index = header.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = row.fields[index];
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function intField(
  row: CsvRow,
  header: string[],
  name: string,
  errors: ListingImportError[],
  opts: { required: boolean; min: number },
): number | null {
  const raw = field(row, header, name);
  if (raw === null) {
    if (opts.required) {
      errors.push({ lineNumber: row.lineNumber, column: name, message: "missing required value" });
    }
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < opts.min) {
    errors.push({
      lineNumber: row.lineNumber,
      column: name,
      message: `"${raw}" is not an integer ≥ ${opts.min}`,
    });
    return null;
  }
  return value;
}

/** Parses attributes_json and returns the object, or pushes a column error. */
function attributesField(
  row: CsvRow,
  header: string[],
  errors: ListingImportError[],
): Record<string, unknown> | null {
  const raw = field(row, header, "attributes_json");
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push({
        lineNumber: row.lineNumber,
        column: "attributes_json",
        message: "must be a JSON object keyed by attribute key",
      });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    errors.push({ lineNumber: row.lineNumber, column: "attributes_json", message: "invalid JSON" });
    return null;
  }
}

/**
 * Pure phase: CSV text → shape-valid rows plus a row-level error report.
 * No database access; identical input always yields an identical report.
 */
export function parseListingCsv(csvText: string): { rows: ParsedRow[]; errors: ListingImportError[] } {
  const csv = parseCsv(csvText);
  const rows: ParsedRow[] = [];
  const errors: ListingImportError[] = [];

  if (!csv.header.includes("title")) {
    errors.push({ lineNumber: 1, column: "title", message: "missing required column in header" });
    return { rows, errors };
  }
  if (!csv.header.includes("categorySlug")) {
    errors.push({ lineNumber: 1, column: "categorySlug", message: "missing required column in header" });
    return { rows, errors };
  }

  for (const csvRow of csv.rows) {
    const rowErrors: ListingImportError[] = [];

    const title = field(csvRow, csv.header, "title");
    if (title === null || title.length < 3 || title.length > 160) {
      rowErrors.push({
        lineNumber: csvRow.lineNumber,
        column: "title",
        message: title === null ? "missing required value" : "must be 3–160 characters",
      });
    }
    const categorySlug = field(csvRow, csv.header, "categorySlug");
    if (categorySlug === null) {
      rowErrors.push({ lineNumber: csvRow.lineNumber, column: "categorySlug", message: "missing required value" });
    }

    // MOQ ladder: tier 1 required; further tiers optional but complete.
    const moqTiers: { minQty: number; unitPriceCents: number }[] = [];
    for (let n = 1; n <= MAX_MOQ_TIERS; n += 1) {
      const minQty = intField(csvRow, csv.header, `moq_${n}_minQty`, rowErrors, { required: n === 1, min: 1 });
      const price = intField(csvRow, csv.header, `moq_${n}_unitPriceCents`, rowErrors, { required: n === 1, min: 1 });
      if (minQty !== null && price !== null) {
        moqTiers.push({ minQty, unitPriceCents: price });
      } else if ((minQty !== null) !== (price !== null)) {
        rowErrors.push({
          lineNumber: csvRow.lineNumber,
          column: `moq_${n}_minQty`,
          message: `tier ${n} needs both minQty and unitPriceCents`,
        });
        break;
      } else if (minQty === null) {
        break; // tier absent — stop scanning further tiers
      }
    }
    if (moqTiers.length === 0 && rowErrors.every((e) => e.column?.startsWith("moq_") !== true)) {
      rowErrors.push({ lineNumber: csvRow.lineNumber, column: "moq_1_minQty", message: "at least one MOQ tier is required" });
    }

    // Lead-time bands: band 1 required; qtyMax empty = open-ended.
    const leadTimeRules: { qtyMin: number; qtyMax: number | null; productionDays: number }[] = [];
    for (let n = 1; n <= MAX_LEAD_BANDS; n += 1) {
      const qtyMin = intField(csvRow, csv.header, `lead_${n}_qtyMin`, rowErrors, { required: n === 1, min: 1 });
      const days = intField(csvRow, csv.header, `lead_${n}_productionDays`, rowErrors, { required: n === 1, min: 1 });
      const qtyMaxRaw = field(csvRow, csv.header, `lead_${n}_qtyMax`);
      let qtyMax: number | null = null;
      if (qtyMaxRaw !== null) {
        const parsedMax = Number(qtyMaxRaw);
        if (!Number.isInteger(parsedMax)) {
          rowErrors.push({
            lineNumber: csvRow.lineNumber,
            column: `lead_${n}_qtyMax`,
            message: `"${qtyMaxRaw}" is not an integer`,
          });
        } else {
          qtyMax = parsedMax;
        }
      }
      if (qtyMin !== null && days !== null) {
        leadTimeRules.push({ qtyMin, qtyMax, productionDays: days });
      } else if (qtyMin === null && days === null) {
        break; // band absent — stop scanning further bands
      }
    }

    // Variants: all optional; a price without a SKU is a row error.
    const variants: NonNullable<ListingUpsertInput["variants"]> = [];
    for (let n = 1; n <= MAX_VARIANTS; n += 1) {
      const sku = field(csvRow, csv.header, `variant_${n}_sku`);
      const price = intField(csvRow, csv.header, `variant_${n}_unitPriceCents`, rowErrors, { required: false, min: 1 });
      if (sku === null) {
        if (price !== null) {
          rowErrors.push({
            lineNumber: csvRow.lineNumber,
            column: `variant_${n}_sku`,
            message: `variant ${n} has a price but no SKU`,
          });
        }
        continue;
      }
      variants.push({ sku, unitPriceCents: price ?? undefined });
    }

    const stockLevelRaw = field(csvRow, csv.header, "stockLevel");
    let stockLevel: ListingUpsertInput["stockLevel"];
    if (stockLevelRaw !== null) {
      const valid = ["OUT_OF_STOCK", "LOW", "IN_STOCK", "MADE_TO_ORDER"];
      if (valid.includes(stockLevelRaw)) {
        stockLevel = stockLevelRaw as NonNullable<ListingUpsertInput["stockLevel"]>;
      } else {
        rowErrors.push({
          lineNumber: csvRow.lineNumber,
          column: "stockLevel",
          message: `"${stockLevelRaw}" is not one of ${valid.join(", ")}`,
        });
      }
    }

    const capacity = intField(csvRow, csv.header, "capacityUnitsPerWeek", rowErrors, { required: false, min: 0 });
    const attributes = attributesField(csvRow, csv.header, rowErrors);

    if (rowErrors.length > 0 || title === null || categorySlug === null) {
      errors.push(...rowErrors);
      continue;
    }

    rows.push({
      lineNumber: csvRow.lineNumber,
      input: {
        title,
        categorySlug,
        description: field(csvRow, csv.header, "description"),
        attributes: attributes ?? {},
        stockLevel,
        capacityUnitsPerWeek: capacity,
        moqTiers,
        leadTimeRules,
        variants: variants.length > 0 ? variants : undefined,
      },
    });
  }

  return { rows, errors };
}

/**
 * Imports a CSV of listings for the acting supplier org. Shape-invalid rows
 * are skipped and reported; shape-valid rows go through
 * ListingRepository.createListing (which re-validates attributes per category
 * and audits the create) one transaction each, so a failure on one row is
 * reported and never affects the others.
 */
export async function importListingsCsv(
  repository: ListingRepository,
  csvText: string,
): Promise<ListingImportReport> {
  const { rows, errors } = parseListingCsv(csvText);
  const imported: ListingImportReport["imported"] = [];

  for (const row of rows) {
    try {
      const listing = await repository.createListing(row.input);
      imported.push({ lineNumber: row.lineNumber, id: listing.id, title: listing.title, slug: listing.slug });
    } catch (error) {
      errors.push({
        lineNumber: row.lineNumber,
        column: null,
        message: error instanceof ListingInputError || error instanceof Error ? error.message : "import failed",
      });
    }
  }

  const rowErrors = errors.filter((e) => e.lineNumber > 1);
  return {
    totalRows: rows.length + rowErrors.length,
    importedCount: imported.length,
    skippedCount: rowErrors.length,
    errors,
    imported,
  };
}

/** Renders the row-level error report as CSV for the download button. */
export function importReportToCsv(report: ListingImportReport): string {
  const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const lines = ["lineNumber,column,message"];
  for (const error of report.errors) {
    lines.push(`${error.lineNumber},${error.column === null ? "" : escape(error.column)},${escape(error.message)}`);
  }
  return lines.join("\r\n") + "\r\n";
}
