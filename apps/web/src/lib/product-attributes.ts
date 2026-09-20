import type { AttributeDefinition, AttributeSet } from "@packsource/db";

/**
 * Deterministic rendering of a validated listing attribute for buyer surfaces.
 * Values are already per-category validated at write time (attributeSet
 * validation), so formatting is total: unknown keys are skipped, known keys
 * format by the definition's type.
 */
export function formatAttributeValue(
  definition: AttributeDefinition,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  switch (definition.type) {
    case "string":
    case "enum":
      return typeof value === "string" && value.length > 0 ? value : null;
    case "number":
    case "integer":
      if (typeof value !== "number") return null;
      return definition.unit
        ? `${value.toLocaleString("en-US")} ${definition.unit}`
        : value.toLocaleString("en-US");
    case "boolean":
      return typeof value === "boolean" ? (value ? "Yes" : "No") : null;
    case "multiEnum":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? value.join(", ")
        : null;
    case "dimensions": {
      if (typeof value !== "object" || value === null) return null;
      const dims = value as { lengthMm?: unknown; widthMm?: unknown; heightMm?: unknown };
      const { lengthMm, widthMm, heightMm } = dims;
      if (
        typeof lengthMm !== "number" ||
        typeof widthMm !== "number" ||
        typeof heightMm !== "number"
      ) {
        return null;
      }
      return `${lengthMm.toLocaleString("en-US")} × ${widthMm.toLocaleString("en-US")} × ${heightMm.toLocaleString("en-US")} mm (L×W×H)`;
    }
    default:
      return null;
  }
}

/** Rows for the attribute table, in the category's declared order. */
export function attributeRows(
  attributeSet: AttributeSet,
  values: Record<string, unknown>,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const definition of attributeSet.attributes) {
    const formatted = formatAttributeValue(definition, values[definition.key]);
    if (formatted !== null) {
      rows.push({ label: definition.label, value: formatted });
    }
  }
  return rows;
}
