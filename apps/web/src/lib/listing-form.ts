import { attributeSetForSlug, type AttributeDefinition, type ListingAttributeValues } from "@packsource/db";
import { STOCK_LEVELS, type ListingUpsertInput } from "@packsource/core";

/**
 * Pure FormData → ListingUpsertInput parsing for the listing editor. Field
 * naming (documented for the UI components):
 *
 *   title, categorySlug, description
 *   stockLevel              optional enum, one of STOCK_LEVELS
 *   capacityUnitsPerWeek    optional non-negative integer
 *   attr_<key>              scalar attributes (checkbox → "on")
 *   attr_<key> (repeated)   multiEnum values
 *   attr_<key>_l/_w/_h      dimensions components, in millimeters
 *   moq_minQty_N/price_N    MOQ tiers 1..5 (tier 1 required)
 *   lead_min_N/max_N/days_N lead-time bands 1..3 (band 1 required, max optional)
 *   variant_sku_N/price_N   variants 1..5 (all optional)
 *
 * Zod remains the authority — the repository re-validates everything; this
 * parser only coerces form strings into the shapes the validators accept and
 * aggregates human-readable errors.
 */

export type ListingFormParse = { ok: true; input: ListingUpsertInput } | { ok: false; error: string };

const MOQ_TIERS = 5;
const LEAD_BANDS = 3;
const VARIANTS = 5;

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(form: FormData, key: string): string | null {
  const value = text(form, key);
  return value === "" ? null : value;
}

function int(form: FormData, key: string, min: number): number | null | "invalid" {
  const raw = text(form, key);
  if (raw === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    return "invalid";
  }
  return value;
}

function scalarValue(definition: AttributeDefinition, raw: string): unknown | "invalid" {
  switch (definition.type) {
    case "number":
    case "integer": {
      const value = Number(raw);
      return Number.isFinite(value) ? value : "invalid";
    }
    case "boolean":
      return raw === "on" || raw === "true";
    default:
      return raw;
  }
}

function attributeValues(form: FormData, categorySlug: string): { values: ListingAttributeValues } | { error: string } {
  const attributeSet = attributeSetForSlug(categorySlug);
  if (!attributeSet) {
    return { error: `unknown category "${categorySlug}"` };
  }
  const values: ListingAttributeValues = {};
  for (const definition of attributeSet.attributes) {
    if (definition.type === "multiEnum") {
      const chosen = form
        .getAll(`attr_${definition.key}`)
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => entry.trim());
      if (chosen.length > 0) {
        values[definition.key] = chosen;
      } else if (definition.required) {
        return { error: `${definition.label} is required` };
      }
      continue;
    }
    if (definition.type === "dimensions") {
      const l = text(form, `attr_${definition.key}_l`);
      const w = text(form, `attr_${definition.key}_w`);
      const h = text(form, `attr_${definition.key}_h`);
      if (l === "" && w === "" && h === "") {
        if (definition.required) {
          return { error: `${definition.label} is required` };
        }
        continue;
      }
      const lengthMm = Number(l);
      const widthMm = Number(w);
      const heightMm = Number(h);
      if (![lengthMm, widthMm, heightMm].every((n) => Number.isFinite(n) && n > 0)) {
        return { error: `${definition.label} needs positive length, width, and height in mm` };
      }
      values[definition.key] = { lengthMm, widthMm, heightMm };
      continue;
    }
    const raw = text(form, `attr_${definition.key}`);
    if (raw === "") {
      if (definition.required) {
        return { error: `${definition.label} is required` };
      }
      continue;
    }
    const value = scalarValue(definition, raw);
    if (value === "invalid") {
      return { error: `${definition.label} must be a ${definition.type}` };
    }
    values[definition.key] = value as never;
  }
  return { values };
}

export function parseListingUpsertForm(form: FormData): ListingFormParse {
  const errors: string[] = [];

  const title = text(form, "title");
  if (title.length < 3 || title.length > 160) {
    errors.push("title must be 3–160 characters");
  }
  const categorySlug = text(form, "categorySlug");
  if (categorySlug === "") {
    errors.push("category is required");
  }

  // MOQ tiers: a pair is complete (both fields) or absent (both empty).
  const moqTiers: ListingUpsertInput["moqTiers"] = [];
  for (let n = 1; n <= MOQ_TIERS; n += 1) {
    const minQtyRaw = text(form, `moq_minQty_${n}`);
    const priceRaw = text(form, `moq_price_${n}`);
    if (minQtyRaw === "" && priceRaw === "") {
      if (n === 1) {
        errors.push("at least one MOQ tier is required");
        break;
      }
      break;
    }
    const minQty = Number(minQtyRaw);
    const price = Number(priceRaw);
    if (!Number.isInteger(minQty) || minQty < 1 || !Number.isInteger(price) || price < 1) {
      errors.push(`MOQ tier ${n} needs a positive integer quantity and unit price in cents`);
      break;
    }
    moqTiers.push({ minQty, unitPriceCents: price });
  }

  const leadTimeRules: ListingUpsertInput["leadTimeRules"] = [];
  for (let n = 1; n <= LEAD_BANDS; n += 1) {
    const minRaw = text(form, `lead_min_${n}`);
    const maxRaw = text(form, `lead_max_${n}`);
    const daysRaw = text(form, `lead_days_${n}`);
    if (minRaw === "" && daysRaw === "") {
      if (n === 1) {
        errors.push("at least one lead-time band is required");
      }
      break;
    }
    const qtyMin = Number(minRaw);
    const productionDays = Number(daysRaw);
    const qtyMax = maxRaw === "" ? null : Number(maxRaw);
    if (
      !Number.isInteger(qtyMin) ||
      qtyMin < 1 ||
      !Number.isInteger(productionDays) ||
      productionDays < 1 ||
      (qtyMax !== null && (!Number.isInteger(qtyMax) || qtyMax < qtyMin))
    ) {
      errors.push(`lead-time band ${n} needs a positive integer quantity range and production days (1–365)`);
      break;
    }
    leadTimeRules.push({ qtyMin, qtyMax, productionDays });
  }

  const variants: NonNullable<ListingUpsertInput["variants"]> = [];
  for (let n = 1; n <= VARIANTS; n += 1) {
    const sku = optionalText(form, `variant_sku_${n}`);
    const priceRaw = text(form, `variant_price_${n}`);
    if (sku === null && priceRaw === "") {
      continue;
    }
    if (sku === null) {
      errors.push(`variant ${n} has a price but no SKU`);
      break;
    }
    const unitPriceCents = priceRaw === "" ? undefined : Number(priceRaw);
    if (unitPriceCents !== undefined && (!Number.isInteger(unitPriceCents) || unitPriceCents < 1)) {
      errors.push(`variant ${n} price must be a positive integer in cents`);
      break;
    }
    variants.push({ sku, unitPriceCents });
  }

  const stockLevelRaw = text(form, "stockLevel");
  let stockLevel: ListingUpsertInput["stockLevel"];
  if (stockLevelRaw !== "") {
    if (STOCK_LEVELS.includes(stockLevelRaw as never)) {
      stockLevel = stockLevelRaw as ListingUpsertInput["stockLevel"];
    } else {
      errors.push(`stock level must be one of: ${STOCK_LEVELS.join(", ")}`);
    }
  }

  const capacity = int(form, "capacityUnitsPerWeek", 0);
  if (capacity === "invalid") {
    errors.push("capacity must be a non-negative integer");
  }

  let attributes: ListingAttributeValues = {};
  if (categorySlug !== "") {
    const parsed = attributeValues(form, categorySlug);
    if ("error" in parsed) {
      errors.push(parsed.error);
    } else {
      attributes = parsed.values;
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }

  return {
    ok: true,
    input: {
      title,
      categorySlug,
      description: optionalText(form, "description"),
      attributes,
      stockLevel,
      capacityUnitsPerWeek: capacity === "invalid" ? undefined : capacity ?? undefined,
      moqTiers,
      leadTimeRules,
      variants: variants.length > 0 ? variants : undefined,
    },
  };
}
