import { z } from "zod";
import { attributeSetForSlug } from "./taxonomy/categories";
import type { AttributeDefinition, AttributeSet, ListingAttributeValues } from "./taxonomy/types";

/**
 * Per-category attribute validation: Zod schemas derived from the category
 * attribute sets (Category.attributeSet). Spec acceptance: "attribute values
 * rejected when violating a category's attribute set."
 *
 * Validation is strict — unknown keys are rejected — so listings cannot carry
 * attributes outside their category's schema.
 */

export class AttributeValidationError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[]) {
    super(
      `Attribute validation failed: ${issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "AttributeValidationError";
    this.issues = issues;
  }
}

// ── Meta-schema for attribute sets themselves (Category.attributeSet rows) ──

const optionList = z.array(z.string().min(1)).min(1);

const attributeDefinitionSchema: z.ZodType<AttributeDefinition> = z.object({
  key: z.string().min(1).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "attribute keys are camelCase identifiers"),
  label: z.string().min(1),
  type: z.enum(["string", "number", "integer", "boolean", "enum", "multiEnum", "dimensions"]),
  required: z.boolean(),
  options: optionList.optional(),
  unit: z.string().min(1).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const attributeSetSchema: z.ZodType<AttributeSet> = z
  .object({
    version: z.literal(1),
    attributes: z.array(attributeDefinitionSchema),
  })
  .strict();

/** Validates (and returns) an attribute-set document, e.g. Category.attributeSet. */
export function parseAttributeSet(value: unknown): AttributeSet {
  const result = attributeSetSchema.safeParse(value);
  if (!result.success) {
    throw new AttributeValidationError(result.error.issues);
  }
  return result.data;
}

// ── Builder ──────────────────────────────────────────────────────────────────

const dimensionsSchema = z
  .object({
    lengthMm: z.number().positive(),
    widthMm: z.number().positive(),
    heightMm: z.number().positive(),
  })
  .strict();

function schemaForAttribute(definition: AttributeDefinition): z.ZodTypeAny {
  const bounded = (schema: z.ZodNumber): z.ZodNumber => {
    let s = schema;
    if (definition.min !== undefined) s = s.min(definition.min);
    if (definition.max !== undefined) s = s.max(definition.max);
    return s;
  };

  switch (definition.type) {
    case "string":
      return z.string().min(1);
    case "number":
      return bounded(z.number());
    case "integer":
      return bounded(z.number().int());
    case "boolean":
      return z.boolean();
    case "enum": {
      if (!definition.options?.length) {
        throw new Error(`Attribute "${definition.key}": enum requires options`);
      }
      return z.enum(definition.options as [string, ...string[]]);
    }
    case "multiEnum": {
      if (!definition.options?.length) {
        throw new Error(`Attribute "${definition.key}": multiEnum requires options`);
      }
      const member = z.enum(definition.options as [string, ...string[]]);
      return definition.required ? z.array(member).min(1) : z.array(member);
    }
    case "dimensions":
      return dimensionsSchema;
  }
}

/**
 * Derives a strict Zod object schema from an attribute-set document. Throws
 * AttributeValidationError when the set itself is malformed.
 */
export function buildAttributeSchema(attributeSet: unknown): z.ZodType<ListingAttributeValues> {
  const set = parseAttributeSet(attributeSet);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const definition of set.attributes) {
    shape[definition.key] = definition.required ? schemaForAttribute(definition) : schemaForAttribute(definition).optional();
  }
  // Zod infers `{ [key: string]: unknown }` for a dynamic shape; every schema
  // built by schemaForAttribute emits JSON values only, so the output type is
  // guaranteed by construction (and re-checked at parse time).
  return z.object(shape).strict() as z.ZodType<ListingAttributeValues>;
}

// ── Validation entry points ──────────────────────────────────────────────────

export type AttributeValidationResult =
  | { success: true; data: ListingAttributeValues }
  | { success: false; error: AttributeValidationError };

/** Validate attribute values against a specific attribute-set document. */
export function safeValidateAttributes(
  attributeSet: unknown,
  values: unknown,
): AttributeValidationResult {
  const schema = buildAttributeSchema(attributeSet);
  const result = schema.safeParse(values);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new AttributeValidationError(result.error.issues) };
}

/**
 * Validate attribute values against the packaged taxonomy by category slug.
 * Throws for unknown category slugs (taxonomy is code-owned).
 */
export function safeValidateAttributesForCategory(
  categorySlug: string,
  values: unknown,
): AttributeValidationResult {
  const attributeSet = attributeSetForSlug(categorySlug);
  if (!attributeSet) {
    throw new Error(`Unknown category slug: ${categorySlug}`);
  }
  return safeValidateAttributes(attributeSet, values);
}

/** Throwing variant for write paths that must not persist invalid attributes. */
export function validateAttributesForCategory(categorySlug: string, values: unknown): ListingAttributeValues {
  const result = safeValidateAttributesForCategory(categorySlug, values);
  if (!result.success) throw result.error;
  return result.data;
}

// ── Partial validation (RFQ specs) ───────────────────────────────────────────

/**
 * Builds a strict-but-optional schema from an attribute-set document: known
 * keys validate against their definitions, every key is optional. RFQ specs
 * are wishes, not listings — a buyer may specify only the attributes they
 * care about — but unknown keys are still rejected so matching overlap stays
 * comparable (spec: "attribute values rejected when violating a category's
 * attribute set").
 */
export function buildPartialAttributeSchema(
  attributeSet: unknown,
): z.ZodType<Record<string, unknown>> {
  const set = parseAttributeSet(attributeSet);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const definition of set.attributes) {
    shape[definition.key] = schemaForAttribute(definition).optional();
  }
  return z.object(shape).strict() as z.ZodType<Record<string, unknown>>;
}

export type PartialAttributeValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: AttributeValidationError };

/** Validate a subset of attribute values against an attribute-set document. */
export function safeValidatePartialAttributes(
  attributeSet: unknown,
  values: unknown,
): PartialAttributeValidationResult {
  const schema = buildPartialAttributeSchema(attributeSet);
  const result = schema.safeParse(values);
  if (result.success) {
    return { success: true, data: result.data as Record<string, unknown> };
  }
  return { success: false, error: new AttributeValidationError(result.error.issues) };
}

/**
 * Validate a subset of attribute values against the packaged taxonomy by
 * category slug. Throws for unknown category slugs (taxonomy is code-owned).
 */
export function validatePartialAttributesForCategory(
  categorySlug: string,
  values: unknown,
): Record<string, unknown> {
  const attributeSet = attributeSetForSlug(categorySlug);
  if (!attributeSet) {
    throw new Error(`Unknown category slug: ${categorySlug}`);
  }
  const result = safeValidatePartialAttributes(attributeSet, values);
  if (!result.success) throw result.error;
  return result.data;
}

/**
 * Validate a single attribute value against one attribute definition.
 * Used by suggestion pipelines (spec extraction) that assemble values
 * incrementally and need per-field checks before a full-set parse.
 */
export function safeValidateSingleAttribute(
  definition: AttributeDefinition,
  value: unknown,
): AttributeValidationResult {
  return safeValidateAttributes({ attributes: [definition] } as unknown, {
    [definition.key]: value,
  });
}
