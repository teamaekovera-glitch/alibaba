/**
 * The documented CSV column contract for the migration importer.
 *
 * docs/importer.md is the human-readable rendering of this file — the two
 * must stay in sync (the docs table links here as the source of truth).
 * Unknown columns are rejected; required columns must be present in the
 * header even when every value is empty.
 */

export type ImportColumnType = "string" | "stringList" | "email" | "phone" | "domain";

export interface ImportColumn {
  /** Exact CSV header name (case-insensitive match after trimming). */
  name: string;
  type: ImportColumnType;
  required: boolean;
  /** Where the value lands, or why it exists if it is not persisted. */
  destination: string;
}

export const IMPORT_COLUMNS: ImportColumn[] = [
  {
    name: "name",
    type: "string",
    required: true,
    destination: "Organization.name (required)",
  },
  {
    name: "city",
    type: "string",
    required: true,
    destination: "Plant.city on the supplier's primary plant (required)",
  },
  {
    name: "state",
    type: "string",
    required: false,
    destination: "Plant.state",
  },
  {
    name: "country",
    type: "string",
    required: false,
    destination: "Plant.country — ISO-3166 alpha-2; defaults to US",
  },
  {
    name: "email",
    type: "email",
    required: false,
    destination: "Organization.billingEmail",
  },
  {
    name: "phone",
    type: "phone",
    required: false,
    destination:
      "Dedup signal only — not persisted. PackSource gates supplier contact details behind quote acceptance (trust rules), so raw phone numbers are not stored",
  },
  {
    name: "domain",
    type: "domain",
    required: false,
    destination: "Dedup signal only — not persisted",
  },
  {
    name: "categories",
    type: "stringList",
    required: false,
    destination:
      "Semicolon-separated taxonomy slugs (top-level or child). Known slugs become Capability rows named category:<slug>; unknown slugs produce a warning, not an error",
  },
  {
    name: "certifications",
    type: "stringList",
    required: false,
    destination:
      "Semicolon-separated claimed certification types (e.g. SQF; BRCGS). Stored as Capability rows named claimed-cert:<TYPE> — deliberately NOT Certification records, which require document evidence and belong to the verification workflow",
  },
  {
    name: "about",
    type: "string",
    required: false,
    destination: "SupplierProfile.about",
  },
];

export const REQUIRED_COLUMN_NAMES: string[] = IMPORT_COLUMNS.filter((c) => c.required).map(
  (c) => c.name,
);

export const ALL_COLUMN_NAMES: string[] = IMPORT_COLUMNS.map((c) => c.name);
