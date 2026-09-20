import { describe, expect, it } from "vitest";

import type { AttributeSet } from "@packsource/db";

import { attributeRows, formatAttributeValue } from "@/lib/product-attributes";

const definition = (overrides: Record<string, unknown>) =>
  overrides as unknown as Parameters<typeof formatAttributeValue>[0];

describe("formatAttributeValue", () => {
  it("formats strings and enums verbatim", () => {
    expect(formatAttributeValue(definition({ type: "string" }), "PET")).toBe("PET");
    expect(formatAttributeValue(definition({ type: "enum" }), "OFFSET")).toBe("OFFSET");
  });

  it("formats numbers with an optional unit and en-US grouping", () => {
    expect(formatAttributeValue(definition({ type: "number", unit: "ml" }), 355)).toBe("355 ml");
    expect(formatAttributeValue(definition({ type: "integer" }), 12_000)).toBe("12,000");
  });

  it("formats booleans as Yes/No", () => {
    expect(formatAttributeValue(definition({ type: "boolean" }), true)).toBe("Yes");
    expect(formatAttributeValue(definition({ type: "boolean" }), false)).toBe("No");
  });

  it("joins multi-enum selections", () => {
    expect(
      formatAttributeValue(definition({ type: "multiEnum" }), ["OFFSET", "DIGITAL"]),
    ).toBe("OFFSET, DIGITAL");
  });

  it("formats dimension triples as L×W×H mm", () => {
    expect(
      formatAttributeValue(definition({ type: "dimensions" }), {
        lengthMm: 120,
        widthMm: 45,
        heightMm: 200,
      }),
    ).toBe("120 × 45 × 200 mm (L×W×H)");
  });

  it("returns null for nullish values and mistyped payloads (validated rows only render)", () => {
    expect(formatAttributeValue(definition({ type: "string" }), null)).toBeNull();
    expect(formatAttributeValue(definition({ type: "string" }), undefined)).toBeNull();
    expect(formatAttributeValue(definition({ type: "number" }), "12")).toBeNull();
    expect(formatAttributeValue(definition({ type: "dimensions" }), { lengthMm: 1 })).toBeNull();
  });
});

describe("attributeRows", () => {
  const attributeSet: AttributeSet = {
    version: 1,
    attributes: [
      { key: "material", label: "Material", type: "string", required: true },
      { key: "volumeMl", label: "Volume", type: "number", required: true, unit: "ml" },
      { key: "hotFillCapable", label: "Hot-fill capable", type: "boolean", required: false },
      { key: "unrecorded", label: "Never set", type: "string", required: false },
    ],
  };

  it("renders rows in the category's declared order, skipping absent values", () => {
    const rows = attributeRows(attributeSet, { material: "PET", volumeMl: 355 });
    expect(rows).toEqual([
      { label: "Material", value: "PET" },
      { label: "Volume", value: "355 ml" },
    ]);
  });

  it("ignores keys the category does not declare", () => {
    const rows = attributeRows(attributeSet, { material: "PET", legacyField: "x" });
    expect(rows).toHaveLength(1);
  });

  it("renders deterministically across calls", () => {
    const values = { material: "PET", volumeMl: 355, hotFillCapable: true };
    expect(attributeRows(attributeSet, values)).toEqual(attributeRows(attributeSet, values));
  });
});
