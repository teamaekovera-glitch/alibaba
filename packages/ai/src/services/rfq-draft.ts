/**
 * AI-drafted RFQ assistance (spec: AI services — "Plain-English brief →
 * structured RFQ (category guess, quantities, target attributes,
 * certifications needed); buyer edits before sending").
 *
 * Mock-mode contract (same pattern as core's spec-extraction): the structured
 * draft values come from this deterministic pipeline over the category's
 * attribute set, so builds, tests, and demos run with zero API keys and
 * identical inputs always produce identical drafts. The reasoning adapter
 * (Claude) is consulted for provenance and a reviewer-facing note; the real
 * adapter will deepen the value pipeline behind the same payload shape.
 *
 * Suggestions are data only — nothing here touches the database, and turning
 * a draft into an RFQ happens exclusively through the buyer-edited RFQ
 * repository methods.
 */
import type { AttributeJsonValue, AttributeSet, ComplianceFramework, ListingAttributeValues } from "@packsource/db";
import { attributeSetForSlug, safeValidatePartialAttributes } from "@packsource/db";
import type { LlmAdapter } from "../types";

/** Buyer-provided inputs for a draft. Attributes may be partial — drafts are wishes, not listings. */
export interface RfqDraftInput {
  categorySlug: string;
  quantity: number;
  /** The buyer's plain-English brief, echoed into the draft verbatim. */
  brief?: string;
  /** Validated attribute values for the category (subset allowed). */
  attributes: ListingAttributeValues;
  /** Certifications the buyer already knows they need. */
  certifications?: ComplianceFramework[];
}

/** One target attribute carried onto the RFQ's spec document. */
export interface RfqDraftTargetAttribute {
  key: string;
  label: string;
  value: AttributeJsonValue;
}

export interface RfqDraftPayload {
  title: string;
  categorySlug: string;
  quantity: number;
  lines: { description: string; quantity: number }[];
  targetAttributes: RfqDraftTargetAttribute[];
  certifications: ComplianceFramework[];
  /** Required attributes the buyer has not filled in yet. */
  unmatchedRequiredKeys: string[];
  /** Plain-English brief assembled from the inputs, shown for buyer editing. */
  briefText: string;
  /** The reasoning adapter's deterministic note (null when unconsulted). */
  assistantNotes: string | null;
  /** Reasoning-adapter model identifier (provenance; null when not consulted). */
  reasoningModel: string | null;
}

const RECYCLABILITY_TO_FRAMEWORK: Record<string, ComplianceFramework> = {
  WIDELY_RECYCLABLE: "RECYCLABLE",
  CHECK_LOCALLY: "RECYCLABLE",
};

/** Category whose dedicated assortment implies a compostability claim. */
const COMPOSTABLE_CATEGORY_SLUG = "sustainable-compostable";

/**
 * Certifications the draft should carry: rules derivable from the validated
 * attribute values (recyclability claims need a RECYCLABLE certification
 * reference; the compostable category implies COMPOSTABLE), plus anything the
 * buyer supplied. Explicit and small by design — a suggestion the buyer edits.
 */
export function suggestedCertifications(
  categorySlug: string,
  attributes: Record<string, unknown>,
  explicit: readonly ComplianceFramework[],
): ComplianceFramework[] {
  const derived = new Set<ComplianceFramework>(explicit);
  const recyclability = attributes["recyclability"];
  if (typeof recyclability === "string") {
    const framework = RECYCLABILITY_TO_FRAMEWORK[recyclability];
    if (framework) derived.add(framework);
  }
  if (categorySlug === COMPOSTABLE_CATEGORY_SLUG) derived.add("COMPOSTABLE");
  return [...derived].sort();
}

function attributeSummaryLine(key: string, label: string, value: AttributeJsonValue): string {
  return `- ${label}: ${typeof value === "string" ? value.toLowerCase().replace(/_/g, " ") : JSON.stringify(value)}`;
}

/**
 * Derives a structured RFQ draft from a category and validated attribute
 * values. Deterministic: identical inputs → identical payload. When a
 * reasoning adapter is supplied it is consulted for provenance and the
 * assistant note, but every structured value stays pipeline-owned.
 */
export async function draftRfq(input: RfqDraftInput, reasoning?: LlmAdapter): Promise<RfqDraftPayload> {
  const attributeSet: AttributeSet | undefined = attributeSetForSlug(input.categorySlug);
  if (!attributeSet) {
    throw new RfqDraftError(`unknown category slug: ${input.categorySlug}`);
  }
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new RfqDraftError(`quantity must be a positive integer, got ${input.quantity}`);
  }

  // Drafts may be partial, but never invalid: unknown or malformed keys are
  // rejected here so downstream matching overlap stays comparable.
  const validated = safeValidatePartialAttributes(attributeSet, input.attributes);
  if (!validated.success) {
    throw new RfqDraftError(`draft attributes violate the ${input.categorySlug} attribute set`, validated.error);
  }
  const attributes = validated.data as ListingAttributeValues;

  const definitionsByKey = new Map(attributeSet.attributes.map((d) => [d.key, d]));
  const targetAttributes: RfqDraftTargetAttribute[] = Object.entries(attributes).map(([key, value]) => ({
    key,
    label: definitionsByKey.get(key)?.label ?? key,
    value,
  }));

  const categoryName = input.categorySlug.replace(/-/g, " ");
  const material = attributes["material"];
  const materialPhrase = typeof material === "string" ? ` in ${material.toLowerCase().replace(/_/g, " ")}` : "";
  const title = `${categoryName} — ${input.quantity.toLocaleString("en-US")} units`;
  const lineDescription = `${input.quantity.toLocaleString("en-US")} × ${categoryName}${materialPhrase}`;

  const summaryLines = targetAttributes.map((a) => attributeSummaryLine(a.key, a.label, a.value));
  const certifications = suggestedCertifications(input.categorySlug, attributes, input.certifications ?? []);
  const briefSections = [
    input.brief ? `Brief: ${input.brief}` : null,
    `Quantity: ${input.quantity.toLocaleString("en-US")} units (${categoryName}${materialPhrase})`,
    summaryLines.length > 0 ? `Target attributes:\n${summaryLines.join("\n")}` : null,
    certifications.length > 0
      ? `Certifications needed: ${certifications.join(", ")}`
      : null,
  ].filter((section): section is string => section !== null);
  const briefText = briefSections.join("\n");

  const consultation = reasoning
    ? await reasoning.complete({
        system: "You are PackSource's RFQ drafting assistant. Review the structured draft for the buyer.",
        messages: [{ role: "user", content: briefText }],
      })
    : null;

  return {
    title,
    categorySlug: input.categorySlug,
    quantity: input.quantity,
    lines: [{ description: lineDescription, quantity: input.quantity }],
    targetAttributes,
    certifications,
    unmatchedRequiredKeys: attributeSet.attributes
      .filter((d) => d.required && !(d.key in attributes))
      .map((d) => d.key),
    briefText,
    assistantNotes: consultation?.text ?? null,
    reasoningModel: consultation?.model ?? null,
  };
}

/** Raised when a draft request is structurally invalid. */
export class RfqDraftError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RfqDraftError";
  }
}
