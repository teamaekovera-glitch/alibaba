import { IMPORT_COLUMNS, ALL_COLUMN_NAMES, REQUIRED_COLUMN_NAMES } from "./column-contract";
import type { ImportColumnType } from "./column-contract";
import { categoryDefinition } from "../taxonomy/categories";
import type { ParsedCsv } from "./parse-csv";

/**
 * Header + row validation against the column contract. File-level problems
 * (missing required columns, unknown columns) throw ImportFileError; row-level
 * problems are collected per row and the row is skipped.
 */

export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

export interface ImportError {
  lineNumber: number;
  column: string | null;
  message: string;
}

export interface ImportRow {
  lineNumber: number;
  name: string;
  city: string;
  state: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  domain: string | null;
  categories: string[];
  certifications: string[];
  about: string | null;
}

export interface RowValidation {
  rows: ImportRow[];
  errors: ImportError[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cellValue(fields: string[], index: number | undefined): string {
  if (index === undefined) return "";
  return (fields[index] ?? "").trim();
}

function splitList(value: string): string[] {
  if (value === "") return [];
  const items = value
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return [...new Set(items)];
}

function validateTyped(type: ImportColumnType, value: string): string | null {
  switch (type) {
    case "email":
      return EMAIL_PATTERN.test(value) ? null : "not a valid email address";
    case "phone":
      return value.replace(/\D/g, "").length >= 7 ? null : "needs at least 7 digits";
    case "domain":
      return value.includes("/") || value.includes(" ")
        ? "must be a bare host (protocol/path stripped by normalization, spaces not allowed)"
        : null;
    default:
      return null;
  }
}

/** Validates the CSV header against the column contract (fatal on mismatch). */
export function validateHeader(header: string[]): void {
  const normalized = header.map((name) => name.trim().toLowerCase());
  const known = new Set(ALL_COLUMN_NAMES);

  const missing = REQUIRED_COLUMN_NAMES.filter((name) => !normalized.includes(name));
  if (missing.length > 0) {
    throw new ImportFileError(
      `CSV header is missing required column(s): ${missing.join(", ")}. See docs/importer.md.`,
    );
  }

  const unknown = normalized.filter((name) => name !== "" && !known.has(name));
  if (unknown.length > 0) {
    throw new ImportFileError(
      `CSV header contains unknown column(s): ${unknown.join(", ")}. ` +
        `The contract columns are: ${ALL_COLUMN_NAMES.join(", ")}. See docs/importer.md.`,
    );
  }
}

/** Maps + validates data rows; collects row-level errors instead of throwing. */
export function readImportRows(csv: ParsedCsv): RowValidation {
  validateHeader(csv.header);

  const normalizedHeader = csv.header.map((name) => name.trim().toLowerCase());
  const columnIndex = new Map<string, number>();
  normalizedHeader.forEach((name, index) => {
    if (name !== "") columnIndex.set(name, index);
  });

  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];

  for (const { lineNumber, fields } of csv.rows) {
    const get = (column: string): string => cellValue(fields, columnIndex.get(column));

    const rowErrors: ImportError[] = [];
    for (const column of IMPORT_COLUMNS) {
      const value = get(column.name);
      if (value === "") continue;
      const problem = validateTyped(column.type, value);
      if (problem !== null) {
        rowErrors.push({ lineNumber, column: column.name, message: problem });
      }
    }

    const name = get("name");
    const city = get("city");
    if (name === "") {
      rowErrors.push({ lineNumber, column: "name", message: "required" });
    }
    if (city === "") {
      rowErrors.push({ lineNumber, column: "city", message: "required" });
    }

    const country = get("country");
    if (country !== "" && !/^[A-Za-z]{2}$/.test(country)) {
      rowErrors.push({
        lineNumber,
        column: "country",
        message: "must be a 2-letter ISO-3166 alpha-2 code",
      });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    // Unknown category slugs warn (the value is dropped) rather than fail —
    // the taxonomy evolves faster than migration files.
    const categories = splitList(get("categories"));
    for (const slug of categories) {
      if (categoryDefinition(slug) === undefined) {
        errors.push({
          lineNumber,
          column: "categories",
          message: `unknown taxonomy slug "${slug}" — value skipped (warning, not fatal)`,
        });
      }
    }

    rows.push({
      lineNumber,
      name,
      city,
      state: get("state") || null,
      country: country === "" ? "US" : country.toUpperCase(),
      email: get("email") || null,
      phone: get("phone") || null,
      domain: get("domain") || null,
      categories: categories.filter((slug) => categoryDefinition(slug) !== undefined),
      certifications: splitList(get("certifications")).map((cert) => cert.toUpperCase()),
      about: get("about") || null,
    });
  }

  return { rows, errors };
}
