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

/** Type aliases (not interfaces) so sets stay assignable to Prisma's Json inputs. */
export type AttributeDefinition = {
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
};

export type AttributeSet = {
  version: 1;
  attributes: AttributeDefinition[];
};

/** JSON value shape — attribute values persist into Prisma Json columns. */
export type AttributeJsonValue =
  | string
  | number
  | boolean
  | null
  | AttributeJsonValue[]
  | { [key: string]: AttributeJsonValue };

/** Validated listing attribute values, as stored in Listing.attributes. */
export type ListingAttributeValues = { [key: string]: AttributeJsonValue };

/** A leaf or top-level taxonomy entry, seeded into Category by the seeder. */
export type CategoryDefinition = {
  slug: string;
  name: string;
  position: number;
  attributeSet: AttributeSet;
  children?: { slug: string; name: string }[];
};
