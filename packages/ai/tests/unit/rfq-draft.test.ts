import { describe, expect, it } from "vitest";
import { MockLlmAdapter } from "../../src/mocks/llm";
import { draftRfq, RfqDraftError, suggestedCertifications } from "../../src/services/rfq-draft";

/**
 * RFQ drafting assistance (spec: AI services). Mock-mode contract: identical
 * inputs → identical structured draft, zero API keys; the reasoning adapter
 * contributes provenance only.
 */

const REASONING = new MockLlmAdapter();

describe("draftRfq", () => {
  it("builds a deterministic structured draft from category + validated attributes", async () => {
    const input = {
      categorySlug: "rigid",
      quantity: 12_000,
      brief: "Clear 12oz hot-fill bottle with tamper band",
      attributes: { material: "PET", volumeMl: 355 },
    };
    const first = await draftRfq(input, REASONING);
    const second = await draftRfq(input, REASONING);

    expect(second).toEqual(first);
    expect(first.title).toBe("rigid — 12,000 units");
    expect(first.lines).toEqual([{ description: "12,000 × rigid in pet", quantity: 12_000 }]);
    expect(first.targetAttributes).toContainEqual({ key: "material", label: "Material", value: "PET" });
    expect(first.unmatchedRequiredKeys).toEqual(["dimensions", "foodContact"]);
    expect(first.reasoningModel).toBe("mock-claude");
    expect(first.assistantNotes).not.toBeNull();
  });

  it("omits the reasoning consultation entirely when no adapter is supplied", async () => {
    const draft = await draftRfq({ categorySlug: "rigid", quantity: 1000, attributes: {} });
    expect(draft.reasoningModel).toBeNull();
    expect(draft.assistantNotes).toBeNull();
  });

  it("flags required attributes the buyer has not filled in", async () => {
    const draft = await draftRfq({ categorySlug: "rigid", quantity: 1000, attributes: {} });
    // material, dimensions, volumeMl, foodContact are required on rigid.
    expect(draft.unmatchedRequiredKeys).toContain("material");
    expect(draft.unmatchedRequiredKeys).toContain("dimensions");
    expect(draft.unmatchedRequiredKeys).toContain("volumeMl");
  });

  it("carries the buyer's brief into briefText verbatim", async () => {
    const draft = await draftRfq({
      categorySlug: "rigid",
      quantity: 1000,
      brief: "Matte black pump bottle",
      attributes: { material: "PP" },
    });
    expect(draft.briefText).toContain("Brief: Matte black pump bottle");
    expect(draft.briefText).toContain("Target attributes:");
  });

  it("rejects attribute values that violate the category set — loudly", async () => {
    await expect(
      draftRfq({ categorySlug: "rigid", quantity: 1000, attributes: { material: "UNOBTANIUM" } }),
    ).rejects.toBeInstanceOf(RfqDraftError);
    await expect(
      draftRfq({ categorySlug: "rigid", quantity: 1000, attributes: { notAnAttribute: true } }),
    ).rejects.toBeInstanceOf(RfqDraftError);
  });

  it("rejects unknown category slugs and non-positive quantities", async () => {
    await expect(draftRfq({ categorySlug: "no-such-category", quantity: 1, attributes: {} })).rejects.toBeInstanceOf(
      RfqDraftError,
    );
    await expect(draftRfq({ categorySlug: "rigid", quantity: 0, attributes: {} })).rejects.toBeInstanceOf(RfqDraftError);
  });
});

describe("suggestedCertifications", () => {
  it("maps recyclability values to the RECYCLABLE framework", () => {
    expect(suggestedCertifications("rigid", { recyclability: "WIDELY_RECYCLABLE" }, [])).toEqual(["RECYCLABLE"]);
    expect(suggestedCertifications("rigid", { recyclability: "CHECK_LOCALLY" }, [])).toEqual(["RECYCLABLE"]);
    expect(suggestedCertifications("rigid", { recyclability: "NOT_RECYCLABLE" }, [])).toEqual([]);
  });

  it("implies COMPOSTABLE for the sustainable category and passes explicit lists through", () => {
    expect(suggestedCertifications("sustainable-compostable", {}, [])).toEqual(["COMPOSTABLE"]);
    expect(suggestedCertifications("rigid", {}, ["BPA_FREE", "KOSHER"])).toEqual(["BPA_FREE", "KOSHER"]);
    expect(suggestedCertifications("sustainable-compostable", {}, ["FSC"])).toEqual(["COMPOSTABLE", "FSC"]);
  });

  it("deduplicates explicit certifications against derived ones", () => {
    expect(suggestedCertifications("rigid", { recyclability: "WIDELY_RECYCLABLE" }, ["RECYCLABLE"])).toEqual([
      "RECYCLABLE",
    ]);
  });
});
