import { describe, expect, it } from "vitest";
import {
  AttributeValidationError,
  attributeSetSchema,
  buildAttributeSchema,
  safeValidateAttributesForCategory,
} from "../../src/attribute-validation";
import {
  CATEGORY_TAXONOMY,
  TOP_LEVEL_CATEGORY_COUNT,
  TOP_LEVEL_CATEGORY_SLUGS,
  attributeSetForSlug,
  categoryDefinition,
  flattenTaxonomy,
} from "../../src/taxonomy/categories";

type Values = Record<string, unknown>;

interface InvalidCase {
  name: string;
  values: Values;
}

interface CategoryMatrix {
  slug: string;
  valid: Values;
  invalid: InvalidCase[];
}

function omit(values: Values, key: string): Values {
  const copy = { ...values };
  delete copy[key];
  return copy;
}

const DIMS = { lengthMm: 120, widthMm: 60, heightMm: 200 };

/**
 * The spec's attribute-validation matrix: every category needs a valid fixture
 * plus at least 10 invalid cases. Shared violations apply to every category;
 * category-specific ones exercise required/bounded attributes unique to each.
 */
function sharedInvalidCases(valid: Values): InvalidCase[] {
  const firstBooleanKey = Object.entries(valid).find(([, v]) => typeof v === "boolean")?.[0];
  const cases: InvalidCase[] = [
    { name: "missing required material", values: omit(valid, "material") },
    { name: "material outside the option list", values: { ...valid, material: "UNOBTAINIUM" } },
    { name: "material with the wrong JSON type", values: { ...valid, material: 123 } },
    { name: "missing required dimensions", values: omit(valid, "dimensions") },
    { name: "negative dimension", values: { ...valid, dimensions: { ...DIMS, lengthMm: -10 } } },
    { name: "incomplete dimensions", values: { ...valid, dimensions: { lengthMm: 120, widthMm: 60 } } },
    { name: "dimension given as a string", values: { ...valid, dimensions: { ...DIMS, widthMm: "60" } } },
    { name: "unknown attribute key", values: { ...valid, surprise: "x" } },
    { name: "printMethod as a bare string instead of an array", values: { ...valid, printMethod: "DIGITAL" } },
    { name: "printMethod with a member outside the options", values: { ...valid, printMethod: ["WOODCUT"] } },
    { name: "printColors above the maximum", values: { ...valid, printColors: 13 } },
    { name: "printColors negative", values: { ...valid, printColors: -1 } },
  ];
  if (firstBooleanKey) {
    cases.push({
      name: `boolean attribute ${firstBooleanKey} as a string`,
      values: { ...valid, [firstBooleanKey]: "true" },
    });
  }
  return cases;
}

const MATRICES: CategoryMatrix[] = [
  {
    slug: "rigid",
    valid: {
      material: "GLASS",
      dimensions: DIMS,
      volumeMl: 355,
      neckFinish: "28-410",
      hotFillCapable: true,
      printMethod: ["OFFSET"],
      printColors: 4,
      finish: "GLOSS",
      recyclability: "WIDELY_RECYCLABLE",
      foodContact: "FOOD_GRADE",
    },
    invalid: [
      { name: "volumeMl below the minimum", values: { material: "GLASS", dimensions: DIMS, volumeMl: 0 } },
      { name: "volumeMl as a string", values: { material: "GLASS", dimensions: DIMS, volumeMl: "355" } },
      { name: "neckFinish outside the option list", values: { material: "GLASS", dimensions: DIMS, volumeMl: 355, neckFinish: "999" } },
    ],
  },
  {
    slug: "flexible",
    valid: {
      material: "MULTILAYER_LAMINATE",
      dimensions: DIMS,
      volumeMl: 250,
      oxygenBarrier: "HIGH",
      moistureBarrier: "MEDIUM",
      reclosable: true,
      printMethod: ["DIGITAL"],
      printColors: 6,
      foodContact: "FOOD_GRADE",
    },
    invalid: [
      { name: "missing required oxygenBarrier", values: { material: "PE", dimensions: DIMS, volumeMl: 250, moistureBarrier: "MEDIUM" } },
      { name: "oxygenBarrier outside the option list", values: { material: "PE", dimensions: DIMS, volumeMl: 250, oxygenBarrier: "IMPERMEABLE", moistureBarrier: "MEDIUM" } },
      { name: "moistureBarrier outside the option list", values: { material: "PE", dimensions: DIMS, volumeMl: 250, oxygenBarrier: "HIGH", moistureBarrier: "DRY" } },
    ],
  },
  {
    slug: "paperboard",
    valid: {
      material: "SBS",
      dimensions: DIMS,
      boardWeightGsm: 350,
      coating: "AQUEOUS",
      printMethod: ["OFFSET"],
      printColors: 4,
      foodContact: "FOOD_GRADE",
    },
    invalid: [
      { name: "boardWeightGsm below the minimum", values: { material: "SBS", dimensions: DIMS, boardWeightGsm: 50 } },
      { name: "boardWeightGsm above the maximum", values: { material: "SBS", dimensions: DIMS, boardWeightGsm: 1000 } },
      { name: "coating outside the option list", values: { material: "SBS", dimensions: DIMS, boardWeightGsm: 350, coating: "WAX" } },
    ],
  },
  {
    slug: "corrugated",
    valid: {
      material: "KRAFT",
      dimensions: DIMS,
      wallType: "DOUBLE_WALL",
      fluting: "BC",
      printMethod: ["FLEXO"],
      printColors: 2,
      foodContact: "NON_FOOD_GRADE",
    },
    invalid: [
      { name: "missing required wallType", values: { material: "KRAFT", dimensions: DIMS } },
      { name: "wallType outside the option list", values: { material: "KRAFT", dimensions: DIMS, wallType: "QUADRUPLE_WALL" } },
      { name: "fluting outside the option list", values: { material: "KRAFT", dimensions: DIMS, wallType: "SINGLE_WALL", fluting: "X" } },
    ],
  },
  {
    slug: "closures-caps",
    valid: {
      material: "PP",
      dimensions: DIMS,
      neckFinish: "38-410",
      linerless: false,
      childResistant: true,
      finish: "GLOSS",
      foodContact: "FOOD_GRADE",
    },
    invalid: [
      { name: "missing required neckFinish", values: { material: "PP", dimensions: DIMS } },
      { name: "neckFinish outside the option list", values: { material: "PP", dimensions: DIMS, neckFinish: "12-TPI" } },
      { name: "linerless as a number", values: { material: "PP", dimensions: DIMS, neckFinish: "38-410", linerless: 1 } },
    ],
  },
  {
    slug: "labels-shrink-sleeves",
    valid: {
      material: "BOPP",
      dimensions: DIMS,
      applicationMethod: "PRESSURE_SENSITIVE",
      adhesiveType: "PERMANENT",
      printMethod: ["DIGITAL"],
      printColors: 6,
      foodContact: "FOOD_GRADE",
    },
    invalid: [
      { name: "missing required applicationMethod", values: { material: "BOPP", dimensions: DIMS } },
      { name: "applicationMethod outside the option list", values: { material: "BOPP", dimensions: DIMS, applicationMethod: "MAGIC" } },
      { name: "adhesiveType outside the option list", values: { material: "BOPP", dimensions: DIMS, applicationMethod: "SHRINK_SLEEVE", adhesiveType: "GLUE" } },
    ],
  },
  {
    slug: "trays-clamshells",
    valid: {
      material: "RPET",
      dimensions: DIMS,
      compartmentCount: 4,
      ovenSafe: false,
      foodContact: "FOOD_GRADE",
    },
    invalid: [
      { name: "compartmentCount below the minimum", values: { material: "RPET", dimensions: DIMS, compartmentCount: 0 } },
      { name: "compartmentCount not an integer", values: { material: "RPET", dimensions: DIMS, compartmentCount: 2.5 } },
      { name: "compartmentCount above the maximum", values: { material: "RPET", dimensions: DIMS, compartmentCount: 25 } },
    ],
  },
  {
    slug: "secondary-tertiary",
    valid: {
      material: "CORRUGATED",
      dimensions: DIMS,
      stackable: true,
      palletizable: true,
      printMethod: ["FLEXO"],
      printColors: 1,
      foodContact: "NON_FOOD_GRADE",
    },
    invalid: [
      { name: "stackable as a string", values: { material: "CORRUGATED", dimensions: DIMS, stackable: "yes" } },
      { name: "material outside the option list for this category", values: { material: "SBS", dimensions: DIMS, foodContact: "NON_FOOD_GRADE" } },
    ],
  },
  {
    slug: "sustainable-compostable",
    valid: {
      material: "BAGASSE",
      dimensions: DIMS,
      compostStandard: "BPI_CERTIFIED",
      recycledContentPct: 70,
      printMethod: ["NONE"],
      foodContact: "FOOD_GRADE",
    },
    invalid: [
      { name: "recycledContentPct above 100", values: { material: "BAGASSE", dimensions: DIMS, recycledContentPct: 101 } },
      { name: "recycledContentPct negative", values: { material: "BAGASSE", dimensions: DIMS, recycledContentPct: -5 } },
      { name: "compostStandard outside the option list", values: { material: "BAGASSE", dimensions: DIMS, compostStandard: "SELF_DECLARED" } },
    ],
  },
];

const ALL_MATRICES: CategoryMatrix[] = MATRICES.map((m) => ({
  ...m,
  invalid: [...m.invalid, ...sharedInvalidCases(m.valid)],
}));

describe("attribute-validation matrix", () => {
  for (const matrix of ALL_MATRICES) {
    describe(matrix.slug, () => {
      it("accepts a fully-populated valid fixture", () => {
        const result = safeValidateAttributesForCategory(matrix.slug, matrix.valid);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(matrix.valid);
        }
      });

      it("accepts optional attributes being absent", () => {
        const minimal = omit(omit(matrix.valid, "printMethod"), "printColors");
        const result = safeValidateAttributesForCategory(matrix.slug, minimal);
        expect(result.success).toBe(true);
      });

      it(`has at least 10 invalid cases (has ${matrix.invalid.length})`, () => {
        expect(matrix.invalid.length).toBeGreaterThanOrEqual(10);
      });

      for (const invalid of matrix.invalid) {
        it(`rejects: ${invalid.name}`, () => {
          const result = safeValidateAttributesForCategory(matrix.slug, invalid.values);
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toBeInstanceOf(AttributeValidationError);
            expect(result.error.issues.length).toBeGreaterThan(0);
          }
        });
      }
    });
  }

  it("rejects a category-valid fixture under another category's attribute set", () => {
    const rigid = ALL_MATRICES.find((m) => m.slug === "rigid")?.valid ?? {};
    const result = safeValidateAttributesForCategory("flexible", rigid);
    expect(result.success).toBe(false);
  });

  it("throws on unknown category slugs", () => {
    expect(() => safeValidateAttributesForCategory("not-a-category", {})).toThrow(
      "Unknown category slug: not-a-category",
    );
  });

  it("reports all violations at once, with paths", () => {
    const result = safeValidateAttributesForCategory("rigid", {
      material: "UNOBTAINIUM",
      dimensions: { ...DIMS, heightMm: -1 },
      volumeMl: 0,
      printColors: 99,
      junk: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("material");
      expect(paths).toContain("dimensions.heightMm");
      expect(paths).toContain("volumeMl");
      expect(paths).toContain("printColors");
      // Unknown keys are rejected; the issue payload references the offending
      // key (its path placement is Zod-version dependent).
      expect(JSON.stringify(result.error.issues)).toContain("junk");
    }
  });
});

describe("taxonomy integrity", () => {
  it("has exactly the nine spec-locked top-level categories, in spec order", () => {
    expect(TOP_LEVEL_CATEGORY_SLUGS).toEqual([
      "rigid",
      "flexible",
      "paperboard",
      "corrugated",
      "closures-caps",
      "labels-shrink-sleeves",
      "trays-clamshells",
      "secondary-tertiary",
      "sustainable-compostable",
    ]);
    expect(CATEGORY_TAXONOMY.length).toBe(TOP_LEVEL_CATEGORY_COUNT);
  });

  it("assigns contiguous positions", () => {
    const positions = CATEGORY_TAXONOMY.map((c) => c.position);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("uses globally-unique slugs across top-level and child categories", () => {
    const slugs = flattenTaxonomy().map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("gives children a valid parent", () => {
    const topSlugs = new Set(TOP_LEVEL_CATEGORY_SLUGS);
    for (const row of flattenTaxonomy().filter((r) => r.parentSlug !== null)) {
      expect(topSlugs.has(row.parentSlug ?? "")).toBe(true);
    }
  });

  it("defines a well-formed attribute set for every category", () => {
    for (const row of flattenTaxonomy()) {
      const set = attributeSetForSlug(row.slug);
      expect(set, `attribute set for ${row.slug}`).toBeDefined();
      expect(() => attributeSetSchema.parse(set)).not.toThrow();
      for (const attribute of set?.attributes ?? []) {
        if (attribute.type === "enum" || attribute.type === "multiEnum") {
          expect(attribute.options?.length, `${row.slug}.${attribute.key} options`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("rejects malformed attribute-set documents", () => {
    expect(() => buildAttributeSchema({ version: 2, attributes: [] })).toThrow(AttributeValidationError);
    expect(() =>
      buildAttributeSchema({
        version: 1,
        attributes: [{ key: "material", label: "Material", type: "enum", required: true }],
      }),
    ).toThrow(/enum requires options/);
    expect(() =>
      buildAttributeSchema({
        version: 1,
        attributes: [{ key: "1bad-key", label: "Bad", type: "string", required: true }],
      }),
    ).toThrow(/camelCase/);
  });

  it("resolves child categories to their inherited attribute set", () => {
    const child = categoryDefinition("stand-up-pouches");
    expect(child?.name).toBe("Stand-Up Pouches");
    expect(child?.attributeSet).toEqual(attributeSetForSlug("flexible"));
    expect(attributeSetForSlug("nope")).toBeUndefined();
  });
});
