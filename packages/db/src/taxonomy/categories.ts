import type { AttributeDefinition, AttributeSet, CategoryDefinition } from "./types";

/**
 * The nine top-level packaging categories locked by the spec's taxonomy
 * section, each carrying its own attribute-set JSON schema. Children are the
 * sub-categories the spec names in its category list.
 *
 * Sustainable/compostable is "a cross-cutting flag as well as a category" —
 * listings in any category may carry the RECYCLABLE / COMPOSTABLE compliance
 * claims (Listing.complianceClaims) while this category holds the dedicated
 * assortment.
 */

export const TOP_LEVEL_CATEGORY_COUNT = 9;

// ── Shared attribute builders (spec attribute families) ──────────────────────

function material(options: string[]): AttributeDefinition {
  return { key: "material", label: "Material", type: "enum", required: true, options };
}

function dimensions(): AttributeDefinition {
  return { key: "dimensions", label: "Dimensions (L×W×H)", type: "dimensions", required: true };
}

function volumeMl(): AttributeDefinition {
  return { key: "volumeMl", label: "Fill volume", type: "number", required: true, unit: "ml", min: 1 };
}

function printMethod(): AttributeDefinition {
  return {
    key: "printMethod",
    label: "Print methods",
    type: "multiEnum",
    required: false,
    options: ["OFFSET", "DIGITAL", "FLEXO", "SCREEN", "HOT_STAMP", "PAD_PRINT", "NONE"],
  };
}

function printColors(): AttributeDefinition {
  return { key: "printColors", label: "Print colors", type: "integer", required: false, min: 0, max: 12 };
}

function finish(): AttributeDefinition {
  return {
    key: "finish",
    label: "Finish",
    type: "enum",
    required: false,
    options: ["MATTE", "GLOSS", "SOFT_TOUCH", "METALLIC", "UNFINISHED"],
  };
}

function recyclability(): AttributeDefinition {
  return {
    key: "recyclability",
    label: "Recyclability",
    type: "enum",
    required: false,
    options: ["WIDELY_RECYCLABLE", "CHECK_LOCALLY", "NOT_RECYCLABLE"],
  };
}

/** OTR/WVTR barrier ratings; required only where shelf life depends on them. */
function barrier(required: boolean): AttributeDefinition[] {
  const levels = ["LOW", "MEDIUM", "HIGH"];
  return [
    { key: "oxygenBarrier", label: "Oxygen barrier (OTR)", type: "enum", required, options: levels },
    { key: "moistureBarrier", label: "Moisture barrier (WVTR)", type: "enum", required, options: levels },
  ];
}

function foodContact(required: boolean): AttributeDefinition {
  return {
    key: "foodContact",
    label: "Food contact grade",
    type: "enum",
    required,
    options: ["FOOD_GRADE", "NON_FOOD_GRADE"],
  };
}

function booleanAttr(key: string, label: string): AttributeDefinition {
  return { key, label, type: "boolean", required: false };
}

// ── Per-category attribute sets ──────────────────────────────────────────────

const rigid: AttributeSet = {
  version: 1,
  attributes: [
    material(["GLASS", "PET", "HDPE", "PP", "ALUMINUM", "TINPLATE"]),
    dimensions(),
    volumeMl(),
    ...barrier(false),
    booleanAttr("hotFillCapable", "Hot-fill capable"),
    {
      key: "neckFinish",
      label: "Neck finish",
      type: "enum",
      required: false,
      options: ["28-410", "28-400", "38-400", "38-410", "53-400", "63-400", "CROWN", "CUSTOM"],
    },
    printMethod(),
    printColors(),
    finish(),
    recyclability(),
    foodContact(true),
  ],
};

const flexible: AttributeSet = {
  version: 1,
  attributes: [
    material(["PE", "PP", "PET", "ALUMINUM_FOIL", "MULTILAYER_LAMINATE", "PAPER"]),
    dimensions(),
    volumeMl(),
    ...barrier(true),
    booleanAttr("hotFillCapable", "Hot-fill capable"),
    booleanAttr("reclosable", "Reclosable"),
    printMethod(),
    printColors(),
    finish(),
    recyclability(),
    foodContact(true),
  ],
};

const paperboard: AttributeSet = {
  version: 1,
  attributes: [
    material(["SBS", "CRB", "KRAFT", "FBB"]),
    dimensions(),
    {
      key: "boardWeightGsm",
      label: "Board weight",
      type: "number",
      required: true,
      unit: "gsm",
      min: 100,
      max: 800,
    },
    {
      key: "coating",
      label: "Coating",
      type: "enum",
      required: false,
      options: ["NONE", "AQUEOUS", "UV", "LAMINATION"],
    },
    printMethod(),
    printColors(),
    finish(),
    recyclability(),
    foodContact(true),
  ],
};

const corrugated: AttributeSet = {
  version: 1,
  attributes: [
    material(["KRAFT", "WHITE_TOP", "CHIP"]),
    dimensions(),
    {
      key: "wallType",
      label: "Wall type",
      type: "enum",
      required: true,
      options: ["SINGLE_WALL", "DOUBLE_WALL", "TRIPLE_WALL"],
    },
    {
      key: "fluting",
      label: "Fluting",
      type: "enum",
      required: false,
      options: ["B", "C", "BC", "EB"],
    },
    printMethod(),
    printColors(),
    recyclability(),
    foodContact(false),
  ],
};

const closuresCaps: AttributeSet = {
  version: 1,
  attributes: [
    material(["PP", "HDPE", "LDPE", "ALUMINUM", "TINPLATE"]),
    dimensions(),
    {
      key: "neckFinish",
      label: "Neck finish",
      type: "enum",
      required: true,
      options: ["28-410", "28-400", "38-400", "38-410", "53-400", "63-400", "CROWN", "CUSTOM"],
    },
    booleanAttr("linerless", "Linerless"),
    booleanAttr("childResistant", "Child resistant"),
    finish(),
    recyclability(),
    foodContact(true),
  ],
};

const labelsShrinkSleeves: AttributeSet = {
  version: 1,
  attributes: [
    material(["PAPER", "BOPP", "PET", "VINYL", "SHRINK_PET"]),
    dimensions(),
    {
      key: "applicationMethod",
      label: "Application method",
      type: "enum",
      required: true,
      options: ["PRESSURE_SENSITIVE", "SHRINK_SLEEVE", "CUT_STACK", "GLUE_APPLIED"],
    },
    {
      key: "adhesiveType",
      label: "Adhesive",
      type: "enum",
      required: false,
      options: ["PERMANENT", "REMOVABLE", "FROZEN", "ALL_TEMPERATURE"],
    },
    printMethod(),
    printColors(),
    finish(),
    recyclability(),
    foodContact(true),
  ],
};

const traysClamshells: AttributeSet = {
  version: 1,
  attributes: [
    material(["APET", "RPET", "PP", "PS", "PLA", "MOLDED_PULP"]),
    dimensions(),
    { key: "compartmentCount", label: "Compartments", type: "integer", required: false, min: 1, max: 24 },
    booleanAttr("ovenSafe", "Oven safe"),
    printMethod(),
    finish(),
    recyclability(),
    foodContact(true),
  ],
};

const secondaryTertiary: AttributeSet = {
  version: 1,
  attributes: [
    material(["CORRUGATED", "PLASTIC_CORRUGATE", "WOOD", "FOAM", "MOLDED_PULP"]),
    dimensions(),
    booleanAttr("stackable", "Stackable"),
    booleanAttr("palletizable", "Palletizable"),
    printMethod(),
    printColors(),
    recyclability(),
    foodContact(false),
  ],
};

const sustainableCompostable: AttributeSet = {
  version: 1,
  attributes: [
    material(["PLA", "BAGASSE", "BAMBOO", "MOLDED_PULP", "RPET", "KRAFT", "COMPOSTABLE_LAMINATE"]),
    dimensions(),
    {
      key: "compostStandard",
      label: "Compost certification",
      type: "enum",
      required: false,
      options: ["BPI_CERTIFIED", "TUV_HOME_OK", "TUV_INDUSTRIAL_OK", "NONE"],
    },
    {
      key: "recycledContentPct",
      label: "Recycled content",
      type: "integer",
      required: false,
      unit: "%",
      min: 0,
      max: 100,
    },
    printMethod(),
    printColors(),
    finish(),
    recyclability(),
    foodContact(true),
  ],
};

// ── Taxonomy ─────────────────────────────────────────────────────────────────

export const CATEGORY_TAXONOMY: CategoryDefinition[] = [
  {
    slug: "rigid",
    name: "Rigid",
    position: 0,
    attributeSet: rigid,
    children: [
      { slug: "glass-bottles", name: "Glass Bottles" },
      { slug: "jars", name: "Jars" },
      { slug: "cans", name: "Cans" },
      { slug: "pet-bottles", name: "PET Bottles" },
      { slug: "hdpe-bottles", name: "HDPE Bottles" },
    ],
  },
  {
    slug: "flexible",
    name: "Flexible",
    position: 1,
    attributeSet: flexible,
    children: [
      { slug: "stand-up-pouches", name: "Stand-Up Pouches" },
      { slug: "spouted-pouches", name: "Spouted Pouches" },
      { slug: "sachets", name: "Sachets" },
      { slug: "films", name: "Films" },
      { slug: "roll-stock", name: "Roll Stock" },
    ],
  },
  {
    slug: "paperboard",
    name: "Paperboard",
    position: 2,
    attributeSet: paperboard,
    children: [
      { slug: "folding-cartons", name: "Folding Cartons" },
      { slug: "rigid-boxes", name: "Rigid Boxes" },
    ],
  },
  { slug: "corrugated", name: "Corrugated", position: 3, attributeSet: corrugated },
  { slug: "closures-caps", name: "Closures & Caps", position: 4, attributeSet: closuresCaps },
  { slug: "labels-shrink-sleeves", name: "Labels & Shrink Sleeves", position: 5, attributeSet: labelsShrinkSleeves },
  { slug: "trays-clamshells", name: "Trays & Clamshells", position: 6, attributeSet: traysClamshells },
  { slug: "secondary-tertiary", name: "Secondary & Tertiary", position: 7, attributeSet: secondaryTertiary },
  {
    slug: "sustainable-compostable",
    name: "Sustainable & Compostable",
    position: 8,
    attributeSet: sustainableCompostable,
  },
];

export const TOP_LEVEL_CATEGORY_SLUGS: string[] = CATEGORY_TAXONOMY.map((c) => c.slug);

/** Flat list of every category row (top-level + children) for the seeder. */
export function flattenTaxonomy(): { slug: string; name: string; parentSlug: string | null; position: number }[] {
  const rows: { slug: string; name: string; parentSlug: string | null; position: number }[] = [];
  for (const top of CATEGORY_TAXONOMY) {
    rows.push({ slug: top.slug, name: top.name, parentSlug: null, position: top.position });
    for (const [i, child] of (top.children ?? []).entries()) {
      rows.push({ slug: child.slug, name: child.name, parentSlug: top.slug, position: i });
    }
  }
  return rows;
}

export function categoryDefinition(slug: string): CategoryDefinition | undefined {
  for (const top of CATEGORY_TAXONOMY) {
    if (top.slug === slug) return top;
    const children = top.children;
    if (!children) continue;
    for (const [index, child] of children.entries()) {
      if (child.slug === slug) {
        return { ...top, slug: child.slug, name: child.name, position: index };
      }
    }
  }
  return undefined;
}

/** The attribute set a category owns; children inherit their parent's set. */
export function attributeSetForSlug(slug: string): AttributeSet | undefined {
  return categoryDefinition(slug)?.attributeSet;
}
