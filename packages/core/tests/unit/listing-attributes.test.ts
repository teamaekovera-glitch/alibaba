import { describe, expect, it } from "vitest";
import {
  attributeSetForSlug,
  flattenTaxonomy,
  generateListingAttributes,
  mulberry32,
  safeValidateSingleAttribute,
  validateAttributesForCategory,
} from "@packsource/db";

/**
 * Per-category attribute validation round-trips: every taxonomy category
 * generates a complete, valid value set, and tampered values of every
 * attribute type are rejected before anything can reach the database.
 */

const ALL_SLUGS = flattenTaxonomy().map((entry) => entry.slug);

function requireSet(slug: string) {
  const set = attributeSetForSlug(slug);
  if (!set) {
    throw new Error(`attribute set missing for ${slug}`);
  }
  return set;
}

describe("per-category attribute round-trips", () => {
  it("validates a generated value set for every category in the taxonomy", () => {
    for (const slug of ALL_SLUGS) {
      const values = generateListingAttributes(mulberry32(42), slug);
      expect(validateAttributesForCategory(slug, values)).toEqual(values);
    }
  });

  it("is deterministic — same seed, same values", () => {
    for (const slug of ALL_SLUGS) {
      const first = generateListingAttributes(mulberry32(7), slug);
      const second = generateListingAttributes(mulberry32(7), slug);
      expect(first).toEqual(second);
    }
  });

  it("rejects unknown categories", () => {
    expect(() => validateAttributesForCategory("no-such-category", {})).toThrow();
  });
});

describe("attribute validation tampering", () => {
  it("rejects unknown attribute keys", () => {
    const slug = ALL_SLUGS[0];
    if (slug === undefined) throw new Error("taxonomy is empty");
    const values = generateListingAttributes(mulberry32(1), slug);
    expect(() => validateAttributesForCategory(slug, { ...values, __bogus__: 1 })).toThrow();
  });

  it("rejects a value set missing a required attribute", () => {
    for (const slug of ALL_SLUGS) {
      const set = requireSet(slug);
      const required = set.attributes.find((definition) => definition.required);
      if (!required) {
        continue;
      }
      const values = generateListingAttributes(mulberry32(3), slug);
      const withoutRequired = { ...values };
      delete withoutRequired[required.key];
      expect(() => validateAttributesForCategory(slug, withoutRequired)).toThrow();
    }
  });

  it("rejects wrong types and out-of-contract values per attribute definition", () => {
    for (const slug of ALL_SLUGS) {
      const set = requireSet(slug);
      const values = generateListingAttributes(mulberry32(5), slug);
      for (const definition of set.attributes) {
        const valid = values[definition.key];
        if (valid !== undefined) {
          expect(safeValidateSingleAttribute(definition, valid).success, `${slug}.${definition.key}`).toBe(true);
        }
        switch (definition.type) {
          case "number":
          case "integer":
            expect(safeValidateSingleAttribute(definition, "12").success).toBe(false);
            break;
          case "enum":
            expect(safeValidateSingleAttribute(definition, "__not_an_option__").success).toBe(false);
            break;
          case "multiEnum":
            expect(safeValidateSingleAttribute(definition, ["__not_an_option__"]).success).toBe(false);
            break;
          case "boolean":
            expect(safeValidateSingleAttribute(definition, "yes").success).toBe(false);
            break;
          case "dimensions":
            expect(safeValidateSingleAttribute(definition, { lengthMm: 10 }).success).toBe(false);
            break;
          case "string":
            expect(safeValidateSingleAttribute(definition, 42).success).toBe(false);
            break;
        }
      }
    }
  });
});
