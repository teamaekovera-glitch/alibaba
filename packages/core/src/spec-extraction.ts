/**
 * Spec-sheet attribute extraction (spec: Supplier console — "spec-sheet PDF
 * upload where Claude extracts attributes into the category's structured
 * fields for human confirmation").
 *
 * Mock-mode contract: the reasoning adapter (Claude) is consulted by the
 * caller for provenance, and the suggestion values themselves come from this
 * deterministic parser so builds, tests, and demos run with zero API keys and
 * identical inputs always produce identical suggestions. The real Claude
 * adapter will replace the value pipeline behind the same SuggestedField
 * shape; the human-confirmation gate in listing-state.ts applies either way.
 *
 * Every suggestion is (a) validated against the category's attribute
 * definition before it is offered, (b) tagged with a confidence level, and
 * (c) traceable to the snippet of spec text that produced it. Suggestions are
 * data only — nothing here touches the database, and applying them to a
 * listing happens exclusively through the human-reviewed repository methods.
 */
import type { AttributeDefinition, AttributeSet } from "@packsource/db";
import { safeValidateSingleAttribute } from "@packsource/db";

export type SuggestionConfidence = "high" | "medium" | "low";

export interface SuggestedField {
  key: string;
  label: string;
  /** JSON value shaped per the attribute type (validated below). */
  value: unknown;
  confidence: SuggestionConfidence;
  /** The exact spec-text snippet the value came from, for human review. */
  evidence: string;
}

export interface SpecExtractionPayload {
  suggestions: SuggestedField[];
  /** Required attributes the spec text said nothing about. */
  unmatchedRequiredKeys: string[];
  /** Reasoning-adapter model identifier (provenance; null when not consulted). */
  reasoningModel: string | null;
  specTextPreview: string;
}

/** Provenance from the reasoning adapter the caller consulted (may be null). */
export interface ReasoningProvenance {
  model: string;
}

const DIMENSIONS_PATTERN = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|millimeters?)\b/i;
const NUMBER_UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*UNIT/i;
const COLOR_COUNT_PATTERN = /(\d+)\s*(?:print\s*)?(?:colou?rs?|inks?)/i;
const LABEL_THEN_VALUE_PATTERN = /(LABEL)\s*[:\-]\s*([A-Za-z0-9 .\-/]{2,60})/;
const NEGATION_PATTERN = /\bno[t]?\s+(LABEL)|LABEL\s*[:\-]\s*(no|false|none)\b/i;
const SNIPPET_CONTEXT_CHARS = 60;

/** Lowercases and strips separators so enum options match prose spellings
 * ("WIDELY_RECYCLABLE" ↔ "widely recyclable"). */
function optionRegex(option: string): RegExp {
  const spaced = option.replace(/_/g, "[\\s_-]?").replace(/[()]/g, "\\$&");
  return new RegExp(`(?<![a-zA-Z])${spaced}(?![a-zA-Z])`, "i");
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + SNIPPET_CONTEXT_CHARS);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** True when the attribute's label (or key) appears just before the match. */
function labelNearby(text: string, definition: AttributeDefinition, matchIndex: number): boolean {
  const window = text.slice(Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS * 2), matchIndex);
  const labelWords = definition.label.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const keyWords = definition.key.replace(/([A-Z])/g, " $1").toLowerCase().split(/\s+/);
  const haystack = window.toLowerCase();
  return (
    labelWords.every((w) => haystack.includes(w)) ||
    keyWords.every((w) => haystack.includes(w))
  );
}

/** Builds one suggestion if `value` survives the attribute's own validation. */
function suggestion(
  text: string,
  definition: AttributeDefinition,
  value: unknown,
  matchIndex: number,
  matchLength: number,
  confidence: SuggestionConfidence,
): SuggestedField | null {
  const validated = safeValidateSingleAttribute(definition, value);
  if (!validated.success) {
    return null;
  }
  return {
    key: definition.key,
    label: definition.label,
    value: validated.data[definition.key],
    confidence,
    evidence: snippetAround(text, matchIndex, matchLength),
  };
}

/**
 * Derives attribute suggestions from raw spec-sheet text for one category's
 * attribute set. Deterministic: identical text + set → identical suggestions.
 */
export function extractSpecSuggestions(specText: string, attributeSet: AttributeSet): SpecExtractionPayload {
  const suggestions: SuggestedField[] = [];
  const matched = new Set<string>();

  for (const definition of attributeSet.attributes) {
    let found: SuggestedField | null = null;

    switch (definition.type) {
      case "dimensions": {
        const match = DIMENSIONS_PATTERN.exec(specText);
        if (match) {
          found = suggestion(
            specText,
            definition,
            { lengthMm: Number(match[1]), widthMm: Number(match[2]), heightMm: Number(match[3]) },
            match.index,
            match[0].length,
            "high",
          );
        }
        break;
      }
      case "number":
      case "integer": {
        // Unit-bearing numbers first ("500 ml"); fall back to label-colon
        // values ("Print colors: 4" via the integer pattern below).
        const unitPattern = definition.unit
          ? new RegExp(NUMBER_UNIT_PATTERN.source.replace("UNIT", definition.unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "i")
          : null;
        const unitMatch = unitPattern?.exec(specText);
        const colorMatch = definition.type === "integer" && !definition.unit ? COLOR_COUNT_PATTERN.exec(specText) : null;
        const match = unitMatch ?? colorMatch;
        if (match) {
          const raw = Number(match[1]);
          const value = definition.type === "integer" ? Math.round(raw) : raw;
          const confident = labelNearby(specText, definition, match.index);
          found = suggestion(specText, definition, value, match.index, match[0].length, confident ? "high" : "medium");
        }
        break;
      }
      case "enum": {
        for (const option of definition.options ?? []) {
          const match = optionRegex(option).exec(specText);
          if (match) {
            found = suggestion(specText, definition, option, match.index, match[0].length, "high");
            break;
          }
        }
        break;
      }
      case "multiEnum": {
        const values: string[] = [];
        for (const option of definition.options ?? []) {
          if (optionRegex(option).test(specText)) values.push(option);
        }
        if (values.length > 0) {
          const anchor = optionRegex(values[0] ?? "").exec(specText);
          if (anchor) {
            found = suggestion(specText, definition, values, anchor.index, anchor[0].length, values.length > 1 ? "high" : "medium");
          }
        }
        break;
      }
      case "boolean": {
        const label = definition.label;
        const negated = new RegExp(NEGATION_PATTERN.source.replaceAll("LABEL", escapeRegex(label)), "i").exec(specText);
        if (negated) {
          found = suggestion(specText, definition, false, negated.index, negated[0].length, "medium");
        } else {
          const positive = new RegExp(`(?<![a-zA-Z])${escapeRegex(label)}(?![a-zA-Z])`, "i").exec(specText);
          if (positive) {
            found = suggestion(specText, definition, true, positive.index, positive[0].length, "medium");
          }
        }
        break;
      }
      case "string": {
        const match = new RegExp(LABEL_THEN_VALUE_PATTERN.source.replace("LABEL", escapeRegex(definition.label)), "i").exec(specText);
        if (match) {
          found = suggestion(specText, definition, match[2]?.trim() ?? "", match.index, match[0].length, "low");
        }
        break;
      }
    }

    if (found) {
      suggestions.push(found);
      matched.add(definition.key);
    }
  }

  return {
    suggestions,
    unmatchedRequiredKeys: attributeSet.attributes
      .filter((d) => d.required && !matched.has(d.key))
      .map((d) => d.key),
    reasoningModel: null, // set by the caller from the reasoning adapter's response
    specTextPreview: specText.slice(0, 200).replace(/\s+/g, " ").trim(),
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Image tag suggestions (Vision adapter, mock-deterministic) ───────────────

export interface ImageSuggestion {
  /** The vision adapter's labels, as-is (deterministic per input bytes). */
  tags: string[];
  /** Suggested alt text assembled from the labels + input fingerprint. */
  suggestedAlt: string;
  /** Fingerprint of the image bytes — traceability in tests and review UI. */
  inputHash: string;
  model: string;
}

/**
 * Maps a Vision adapter result to reviewable image metadata. Pure: the tags
 * are exactly the adapter's labels; the alt text embeds the content hash so
 * identical bytes always suggest identical metadata.
 */
export function suggestImageTags(vision: { labels: string[]; model: string; inputHash: string }): ImageSuggestion {
  return {
    tags: [...vision.labels],
    suggestedAlt: `Suggested by ${vision.model}: ${vision.labels.join(", ")} (image ${vision.inputHash.slice(0, 12)})`,
    inputHash: vision.inputHash,
    model: vision.model,
  };
}
