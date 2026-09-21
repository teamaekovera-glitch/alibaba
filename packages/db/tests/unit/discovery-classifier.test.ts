import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifySupplier,
  DISCOVERY_FIELD_WEIGHTS,
  MAX_CATEGORY_SLUGS,
  SECONDARY_MIN_SCORE,
} from "../../src/discovery/classify";
import {
  DISCOVERY_CATEGORIES,
  DISCOVERY_CATEGORY_SLUGS,
  isDiscoveryCategorySlug,
  OTHER_GENERAL_SLUG,
} from "../../src/discovery/taxonomy";
import { readPlatformSupplierRows } from "../../src/discovery/import-rows";

/**
 * Classifier pins against real Platform Ready records (spec acceptance:
 * "unit tests with real sampled records"). Field text below is verbatim from
 * the committed fixture — if a tuning pass changes these assignments, the
 * keyword table changed behavior on real data and the PR must say so.
 */
const CLEANLOGIC = {
  specialty:
    "bath and body care brand and manufacturer specializing in exfoliating cloths, facial tools, and body care products; private label manufacturing; employs individuals with disabilities",
  products: "exfoliating cloths, facial tools, body care products",
  description:
    "Cleanlogic is a leading bath and body care brand and manufacturer based in Audubon, PA. They specialize in exfoliating cloths, facial tools, and body care products, with a mission to employ individuals with disabilities. They operate a production facility and offer private label manufacturing services.",
  supplierTypes: ["Private Label Manufacturer"],
};

const SWEET_SAMS = {
  specialty: "Cookies, Dessert Bars, Muffins, Croissants, Pound Cakes, Cupcakes, Scones",
  products: null,
  description:
    "Sweet Sam's Baking Company is a wholesale bakery in the Bronx, NY, known for pound cakes, cookies, cupcakes, and scones. Founded in 1991, it uses real butter and fruit, no artificial colors, flavors, or preservatives, and operates in an 80,000 sq ft facility.",
  supplierTypes: ["Food Manufacturer / Brand"],
};

const FLATLANDS = {
  specialty: "USDA Certified Organic grain cleaning and bagging operation",
  products: "whole proso millet and other grains",
  description:
    "Flatlands Processing LLC is a USDA Certified Organic grain cleaning and bagging operation located in Haxtun, Colorado. It cleans and bags whole proso millet and other grains for wholesale distribution.",
  supplierTypes: ["Ingredient Supplier"],
};

describe("classifySupplier — pinned real records", () => {
  it("sends Cleanlogic to health-beauty", () => {
    const result = classifySupplier(CLEANLOGIC);
    expect(result.primaryCategory).toBe("health-beauty");
  });

  it("sends Sweet Sam's Baking Company to bakery", () => {
    const result = classifySupplier(SWEET_SAMS);
    expect(result.primaryCategory).toBe("bakery");
  });

  it("sends Flatlands Processing to grains-baking", () => {
    const result = classifySupplier(FLATLANDS);
    expect(result.primaryCategory).toBe("grains-baking");
  });

  it(
    "assigns every committed fixture row a recognized primary category",
    // 7,658-row CSV parse + full-corpus classification is pure CPU work that
    // sits near vitest's 5s default under CI's parallel-suite contention.
    { timeout: 60_000 },
    () => {
      const fixture = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../fixtures/platform-suppliers/platform-ready-20260817.csv",
      );
      const { rows, errors } = readPlatformSupplierRows(readFileSync(fixture, "utf8"));
      expect(errors).toEqual([]);
      expect(rows.length).toBe(7658);
      for (const row of rows) {
        expect(isDiscoveryCategorySlug(row.primaryCategory)).toBe(true);
      }
    },
  );
});

describe("classifySupplier — fallback and determinism", () => {
  it("returns other-general for a zero-match record", () => {
    const result = classifySupplier({
      specialty: "logistics coordination",
      products: "pallets",
      description: "Regional trucking cooperative.",
      supplierTypes: ["Distributor / Wholesaler"],
    });
    expect(result.primaryCategory).toBe(OTHER_GENERAL_SLUG);
    expect(result.categorySlugs).toEqual([OTHER_GENERAL_SLUG]);
  });

  it("handles an entirely empty record without throwing", () => {
    const result = classifySupplier({});
    expect(result.primaryCategory).toBe(OTHER_GENERAL_SLUG);
  });

  it("is deterministic: identical input, identical assignment", () => {
    const a = classifySupplier(CLEANLOGIC);
    const b = classifySupplier(CLEANLOGIC);
    expect(a).toEqual(b);
    expect(a.scores).toEqual(b.scores);
  });
});

describe("classifySupplier — scoring rules", () => {
  it("weights specialty above supplier type (3 vs 2)", () => {
    // "cheese" in specialty (3) must beat "Co-Packer" type (2).
    const result = classifySupplier({
      specialty: "cheese production",
      supplierTypes: ["Co-Packer"],
    });
    expect(result.primaryCategory).toBe("dairy");
  });

  it("matches a keyword at most once per field, so verbose descriptions do not out-shout", () => {
    const chatty = classifySupplier({
      description: "cheese cheese cheese and more cheese, all the cheese there is",
    });
    const terse = classifySupplier({ description: "cheese" });
    // Same single matched keyword → same score regardless of repetition.
    expect(chatty.scores.dairy).toBe(terse.scores.dairy);
    expect(chatty.scores.dairy).toBe(DISCOVERY_FIELD_WEIGHTS.description);
  });

  it("caps category slugs at MAX_CATEGORY_SLUGS with the primary first", () => {
    // A record with many category signals must never carry more than three.
    const result = classifySupplier({
      specialty: "coffee, tea, cheese, snack bars, pet treats, salsa, seafood",
      products: "cookies, supplements, flour",
      description: "co-packing for juice, meat, and frozen meals",
      supplierTypes: ["Co-Packer", "Packaging Supplier"],
    });
    expect(result.categorySlugs.length).toBe(MAX_CATEGORY_SLUGS);
    expect(result.categorySlugs[0]).toBe(result.primaryCategory);
    for (const slug of result.categorySlugs) {
      expect(DISCOVERY_CATEGORY_SLUGS).toContain(slug);
    }
  });

  it("only adds secondaries at or above SECONDARY_MIN_SCORE", () => {
    // Description-only pet-food signal (1 point) stays below the secondary bar.
    const result = classifySupplier({
      specialty: "cheese production",
      description: "also serves the pet food industry",
    });
    expect(result.primaryCategory).toBe("dairy");
    expect(result.categorySlugs).not.toContain("pet-food");
  });
});

describe("classifySupplier — word-boundary safety", () => {
  it("never confuses PET plastic with pet food", () => {
    // Regression: bare "pet" pulled real packaging suppliers into Pet Food
    // (7 misassignments seen in the import report before the fix).
    const result = classifySupplier({
      specialty: "PET bottles and preforms",
      products: "PET containers, plastic jars",
      supplierTypes: ["Packaging Supplier"],
      description: "Manufacturer of PET packaging for beverages.",
    });
    expect(result.primaryCategory).toBe("packaging-services");
  });

  it("does not match keywords embedded in larger words", () => {
    const result = classifySupplier({ description: "a team player from Petaluma" });
    expect(result.primaryCategory).toBe(OTHER_GENERAL_SLUG);
  });
});

describe("discovery taxonomy table", () => {
  it("has 16 categories with unique slugs, card copy, and artwork", () => {
    expect(DISCOVERY_CATEGORIES.length).toBe(16);
    expect(new Set(DISCOVERY_CATEGORY_SLUGS).size).toBe(16);
    for (const category of DISCOVERY_CATEGORIES) {
      expect(category.name.length).toBeGreaterThan(0);
      expect(category.description.length).toBeGreaterThan(0);
      expect(category.image).toBe(`/discovery/${category.slug}.jpg`);
    }
  });

  it("ends with the empty-rule other-general fallback", () => {
    const last = DISCOVERY_CATEGORIES.at(-1);
    expect(last?.slug).toBe(OTHER_GENERAL_SLUG);
    expect(last?.keywords).toEqual([]);
  });

  it("exports the pinned field weights", () => {
    expect(DISCOVERY_FIELD_WEIGHTS).toEqual({
      specialty: 3,
      products: 2,
      supplierType: 2,
      description: 1,
    });
    expect(SECONDARY_MIN_SCORE).toBe(2);
  });
});
