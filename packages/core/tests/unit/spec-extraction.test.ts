import { describe, expect, it } from "vitest";
import { attributeSetForSlug, flattenTaxonomy, type AttributeSet } from "@packsource/db";
import { extractSpecSuggestions, suggestImageTags } from "../../src/index";

/**
 * The extraction mocks must be deterministic (same input → same suggestions),
 * every suggestion must validate against its own attribute definition, and
 * every suggestion must be traceable to the spec text that produced it.
 */

const ALL_SLUGS = flattenTaxonomy().map((entry) => entry.slug);

function requireSet(slug: string): AttributeSet {
  const set = attributeSetForSlug(slug);
  if (!set) {
    throw new Error(`attribute set missing for ${slug}`);
  }
  return set;
}

/** Builds a spec text that mentions every attribute definition once. */
function specTextFor(set: AttributeSet): string {
  const lines: string[] = [];
  for (const definition of set.attributes) {
    if (definition.type === "number" || definition.type === "integer") {
      lines.push(`${definition.label}: 42 ${definition.unit ?? ""}`.trim());
    } else if (definition.type === "enum") {
      const option = definition.options?.[0];
      if (option !== undefined) lines.push(`${definition.label}: ${option}`);
    } else if (definition.type === "multiEnum") {
      const joined = (definition.options ?? []).slice(0, 2).join(" and ");
      if (joined !== "") lines.push(joined);
    } else if (definition.type === "boolean") {
      lines.push(`${definition.label}: yes`);
    } else if (definition.type === "dimensions") {
      lines.push(`${definition.label}: 190 x 120 x 45 mm`);
    } else {
      lines.push(`${definition.label}: high gloss`);
    }
  }
  return lines.join("\n");
}

describe("deterministic spec extraction", () => {
  it("produces identical suggestions for identical input", () => {
    for (const slug of ALL_SLUGS) {
      const set = requireSet(slug);
      const text = specTextFor(set);
      const first = extractSpecSuggestions(text, set);
      const second = extractSpecSuggestions(text, set);
      expect(second).toEqual(first);
    }
  });

  it("only suggests defined attributes, with contract-valid values and evidence", () => {
    for (const slug of ALL_SLUGS) {
      const set = requireSet(slug);
      const text = specTextFor(set);
      // evidence is quoted from the spec text with whitespace collapsed —
      // compare against the same normalization
      const normalizedText = text.replace(/\s+/g, " ");
      const payload = extractSpecSuggestions(text, set);
      for (const suggestion of payload.suggestions) {
        const definition = set.attributes.find((d) => d.key === suggestion.key);
        expect(definition, `${slug} defines ${suggestion.key}`).toBeDefined();
        expect(["high", "medium", "low"]).toContain(suggestion.confidence);
        expect(suggestion.evidence.length).toBeGreaterThan(0);
        expect(normalizedText.includes(suggestion.evidence), `evidence for ${suggestion.key}`).toBe(true);
      }
    }
  });
});

describe("extraction on unmatched text", () => {
  it("suggests nothing and lists every required key as unmatched", () => {
    const slug = ALL_SLUGS[0];
    if (slug === undefined) throw new Error("taxonomy is empty");
    const set = requireSet(slug);
    const payload = extractSpecSuggestions("lorem ipsum dolor sit amet", set);
    expect(payload.suggestions).toEqual([]);
    const requiredKeys = set.attributes.filter((d) => d.required).map((d) => d.key);
    expect(payload.unmatchedRequiredKeys.sort()).toEqual([...requiredKeys].sort());
  });
});

describe("deterministic image tagging", () => {
  it("returns the same tags and alt text for the same input", () => {
    const input = { labels: ["bottle", "plastic", "clear"], model: "mock-vision", inputHash: "abc123" };
    const first = suggestImageTags(input);
    const second = suggestImageTags(input);
    expect(second).toEqual(first);
    expect(first.tags).toEqual(["bottle", "plastic", "clear"]);
    expect(first.suggestedAlt).toContain("bottle");
    expect(first.model).toBe("mock-vision");
    expect(first.inputHash).toBe("abc123");
  });
});
