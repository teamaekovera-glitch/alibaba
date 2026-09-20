import { describe, expect, it } from "vitest";
import { attributeSetForSlug, generateListingAttributes, mulberry32, TOP_LEVEL_CATEGORY_SLUGS } from "@packsource/db";
import { parseListingUpsertForm } from "../../src/lib/listing-form";

/**
 * FormData → ListingUpsertInput parsing for the listing editor. The taxonomy
 * itself is exercised for real: values generated for a real category are
 * serialised through the documented field naming and must round-trip.
 */

function firstSlug(): string {
  const slug = TOP_LEVEL_CATEGORY_SLUGS[0];
  if (slug === undefined) throw new Error("taxonomy has no top-level categories");
  return slug;
}

function slugWithDimensions(): string | undefined {
  for (const slug of TOP_LEVEL_CATEGORY_SLUGS) {
    const set = attributeSetForSlug(slug);
    if (set?.attributes.some((d) => d.type === "dimensions")) {
      return slug;
    }
  }
  return undefined;
}

function fillAttributes(form: FormData, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        form.append(`attr_${key}`, String(item));
      }
    } else if (typeof value === "object" && value !== null) {
      const dims = value as { lengthMm?: unknown; widthMm?: unknown; heightMm?: unknown };
      form.set(`attr_${key}_l`, String(dims.lengthMm));
      form.set(`attr_${key}_w`, String(dims.widthMm));
      form.set(`attr_${key}_h`, String(dims.heightMm));
    } else if (typeof value === "boolean") {
      if (value) {
        form.set(`attr_${key}`, "on"); // unchecked boxes are simply absent
      }
    } else {
      form.set(`attr_${key}`, String(value));
    }
  }
}

/** Generated values minus false booleans — absent checkboxes parse as absent. */
function expectedAttributes(values: Record<string, unknown>): Record<string, unknown> {
  const expected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "boolean" && value === false) {
      continue;
    }
    expected[key] = value;
  }
  return expected;
}

describe("parseListingUpsertForm", () => {
  it("round-trips a complete generated value set for a real category", () => {
    const slug = firstSlug();
    const set = attributeSetForSlug(slug);
    if (!set) throw new Error(`attribute set missing for ${slug}`);
    const values = generateListingAttributes(mulberry32(7), slug);

    const form = new FormData();
    form.set("title", "Test PET bottle 500ml");
    form.set("categorySlug", slug);
    form.set("description", "A description");
    form.set("stockLevel", "IN_STOCK");
    form.set("capacityUnitsPerWeek", "10000");
    fillAttributes(form, values);
    form.set("moq_minQty_1", "500");
    form.set("moq_price_1", "42");
    form.set("lead_min_1", "500");
    form.set("lead_days_1", "10");

    const parsed = parseListingUpsertForm(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.title).toBe("Test PET bottle 500ml");
    expect(parsed.input.categorySlug).toBe(slug);
    expect(parsed.input.description).toBe("A description");
    expect(parsed.input.stockLevel).toBe("IN_STOCK");
    expect(parsed.input.capacityUnitsPerWeek).toBe(10000);
    expect(parsed.input.attributes).toEqual(expectedAttributes(values));
  });

  it("parses MOQ tiers, lead-time bands, and variants", () => {
    const slug = firstSlug();
    const form = new FormData();
    form.set("title", "Ladder round trip");
    form.set("categorySlug", slug);
    // per-category attributes are required by the parser — fill a valid set
    fillAttributes(form, generateListingAttributes(mulberry32(17), slug));
    form.set("moq_minQty_1", "500");
    form.set("moq_price_1", "42");
    form.set("moq_minQty_2", "1000");
    form.set("moq_price_2", "39");
    form.set("lead_min_1", "500");
    form.set("lead_days_1", "10");
    form.set("lead_min_2", "1000");
    form.set("lead_max_2", "5000");
    form.set("lead_days_2", "15");
    form.set("variant_sku_1", "SKU-1");
    form.set("variant_price_1", "44");

    const parsed = parseListingUpsertForm(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.moqTiers).toEqual([
      { minQty: 500, unitPriceCents: 42 },
      { minQty: 1000, unitPriceCents: 39 },
    ]);
    expect(parsed.input.leadTimeRules).toEqual([
      { qtyMin: 500, qtyMax: null, productionDays: 10 },
      { qtyMin: 1000, qtyMax: 5000, productionDays: 15 },
    ]);
    expect(parsed.input.variants).toEqual([{ sku: "SKU-1", unitPriceCents: 44 }]);
  });

  it("aggregates human-readable errors for missing required structure", () => {
    const form = new FormData();
    form.set("title", "No ladder here");
    form.set("categorySlug", firstSlug());

    const parsed = parseListingUpsertForm(form);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("at least one MOQ tier");
    expect(parsed.error).toContain("at least one lead-time band");
  });

  it("rejects unknown categories", () => {
    const form = new FormData();
    form.set("title", "Unknown category");
    form.set("categorySlug", "no-such-category");

    const parsed = parseListingUpsertForm(form);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("unknown category");
  });

  it("rejects titles outside 3–160 characters and bad stock levels", () => {
    const form = new FormData();
    form.set("title", "No");
    form.set("categorySlug", firstSlug());
    form.set("moq_minQty_1", "500");
    form.set("moq_price_1", "42");
    form.set("lead_min_1", "500");
    form.set("lead_days_1", "10");
    form.set("stockLevel", "SORT_OF_STOCK");

    const parsed = parseListingUpsertForm(form);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("title must be 3–160 characters");
    expect(parsed.error).toContain("stock level must be one of");
  });

  it("rejects partial dimensions", () => {
    const slug = slugWithDimensions();
    expect(slug).toBeDefined();
    if (slug === undefined) return;
    const set = attributeSetForSlug(slug);
    if (!set) throw new Error(`attribute set missing for ${slug}`);
    const dimensionsKey = set.attributes.find((d) => d.type === "dimensions")?.key;
    if (dimensionsKey === undefined) throw new Error("dimensions key missing");

    // fill every other attribute so the partial dimensions is the only error
    const values = generateListingAttributes(mulberry32(21), slug);
    const withoutDimensions = { ...values };
    delete withoutDimensions[dimensionsKey];

    const form = new FormData();
    form.set("title", "Partial dimensions");
    form.set("categorySlug", slug);
    form.set("moq_minQty_1", "500");
    form.set("moq_price_1", "42");
    form.set("lead_min_1", "500");
    form.set("lead_days_1", "10");
    fillAttributes(form, withoutDimensions);
    form.set(`attr_${dimensionsKey}_l`, "190");

    const parsed = parseListingUpsertForm(form);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("needs positive length, width, and height");
  });
});
