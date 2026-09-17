/**
 * Generates listing attribute values that validate against the category's
 * attribute set. Every generated object is re-validated with the production
 * Zod validators before it reaches the database — a seeder bug surfaces as a
 * loud error, never as invalid demo data.
 */

import { attributeSetForSlug } from "../taxonomy/categories";
import type { AttributeDefinition, ListingAttributeValues } from "../taxonomy/types";
import { validateAttributesForCategory } from "../attribute-validation";
import { pick } from "./rng";
import type { SeedRng } from "./rng";

function numberInRange(rng: SeedRng, definition: AttributeDefinition): number {
  const min = definition.min ?? 1;
  const max = definition.max ?? min * 4;
  const value = min + rng() * (max - min);
  return definition.type === "integer" ? Math.round(value) : Math.round(value * 10) / 10;
}

function valueFor(rng: SeedRng, definition: AttributeDefinition): ListingAttributeValues[string] {
  switch (definition.type) {
    case "string":
      return pick(rng, ["Standard", "Premium", "Economy", "Custom"]);
    case "number":
    case "integer":
      return numberInRange(rng, definition);
    case "boolean":
      return rng() < 0.5;
    case "enum": {
      const options = definition.options ?? [];
      return pick(rng, options);
    }
    case "multiEnum": {
      const options = definition.options ?? [];
      const count = Math.max(definition.required ? 1 : 0, Math.ceil(rng() * Math.min(3, options.length)));
      const values: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const option = pick(rng, options);
        if (!values.includes(option)) values.push(option);
      }
      return values.length > 0 ? values : [options[0] ?? "NONE"];
    }
    case "dimensions":
      // Positive, deterministic package dimensions in mm.
      return {
        lengthMm: 60 + Math.floor(rng() * 340),
        widthMm: 40 + Math.floor(rng() * 220),
        heightMm: 20 + Math.floor(rng() * 300),
      };
  }
}

/**
 * Builds a full attribute payload for a category. Throws when the generated
 * payload fails the category's production Zod schema (defensive: the seeder
 * must never persist attributes the validators would reject).
 */
export function generateListingAttributes(rng: SeedRng, categorySlug: string): ListingAttributeValues {
  const set = attributeSetForSlug(categorySlug);
  if (!set) throw new Error(`Unknown category slug: ${categorySlug}`);

  const values: ListingAttributeValues = {};
  for (const definition of set.attributes) {
    if (!definition.required && rng() < 0.35) continue; // optional attrs sometimes omitted
    values[definition.key] = valueFor(rng, definition);
  }
  // Validate with the production validator and persist its parsed output.
  return validateAttributesForCategory(categorySlug, values);
}
