/**
 * Attribute-set dialect shared by the Category.attributeSet JSON column and the
 * Zod validation derived from it (see attribute-validation.ts).
 *
 * The dialect is deliberately minimal: each category declares a flat list of
 * typed attributes; the validator enforces exactly those keys (unknown keys are
 * rejected) with per-type bounds. Spec: "Attribute sets cover material,
 * dimensions, volume, barrier properties (OTR/WVTR), print method, colors,
 * finish, recyclability, and food-contact compliance."
 */

export type AttributeType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "multiEnum"
  | "dimensions";

export interface AttributeDefinition {
  key: string;
  label: string;
  type: AttributeType;
  /** Required attributes must be present; optional ones are validated when present. */
  required: boolean;
  /** Allowed values for enum / multiEnum. */
  options?: string[];
  /** Display unit for number / integer (e.g. "ml", "gsm"). */
  unit?: string;
  min?: number;
  max?: number;
}

export interface AttributeSet {
  version: 1;
  attributes: AttributeDefinition[];
}

/** Validated listing attribute values, as stored in Listing.attributes. */
export type ListingAttributeValues = Record<string, unknown>;

/** A leaf or top-level taxonomy entry, seeded into Category by the seeder. */
export interface CategoryDefinition {
  slug: string;
  name: string;
  position: number;
  attributeSet: AttributeSet;
  children?: { slug: string; name: string }[];
}
