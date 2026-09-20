import { describe, expect, it } from "vitest";
import { MockVisionAdapter } from "@packsource/ai";
import { visualTagFilters, visualTagsForImage } from "../../src/visual";

describe("visualTagsForImage", () => {
  it("returns the mock's deterministic tags for the same bytes", async () => {
    const vision = new MockVisionAdapter();
    const image = { base64: "aGVsbG8=", mimeType: "image/png" };
    const first = await visualTagsForImage(vision, image);
    const second = await visualTagsForImage(vision, image);
    expect(first.labels).toEqual(["packaging", "container", "product-photo"]);
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.model).toBe("mock-gemini-vision");
  });

  it("fingerprints different bytes differently", async () => {
    const vision = new MockVisionAdapter();
    const a = await visualTagsForImage(vision, { base64: "aaa", mimeType: "image/png" });
    const b = await visualTagsForImage(vision, { base64: "bbb", mimeType: "image/png" });
    expect(a.inputHash).not.toBe(b.inputHash);
  });
});

describe("visualTagFilters", () => {
  it("maps material labels to the material facet", () => {
    const { filters, keywordText } = visualTagFilters(["glass", "bottle"]);
    expect(filters.material).toEqual(["GLASS"]);
    expect(keywordText).toBe("bottle");
  });

  it("maps sustainability and boolean-flag labels", () => {
    const { filters, keywordText } = visualTagFilters(["Recyclable", "Hot-Fill", "product-photo"]);
    expect(filters.sustainability).toEqual(["recyclable"]);
    expect(filters.booleanFlags).toEqual(["hotFillCapable"]);
    expect(keywordText).toBe("product-photo");
  });

  it("unions tag filters with caller filters without duplicates", () => {
    const { filters } = visualTagFilters(["glass", "pet"], {
      material: ["PET"],
      certifications: ["SQF"],
    });
    expect(filters.material).toEqual(["PET", "GLASS"]);
    expect(filters.certifications).toEqual(["SQF"]);
  });

  it("keeps the mock's generic labels as keyword text with empty facet filters", () => {
    const { filters, keywordText } = visualTagFilters(["packaging", "container", "product-photo"]);
    expect(filters.material).toBeUndefined();
    expect(filters.sustainability).toBeUndefined();
    expect(filters.booleanFlags).toBeUndefined();
    expect(keywordText).toBe("packaging container product-photo");
  });

  it("ignores blank labels", () => {
    const { keywordText } = visualTagFilters(["", "   ", "glass"]);
    expect(keywordText).toBe("");
  });
});
