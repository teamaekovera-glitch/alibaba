import { fnv1aHex } from "../fnv";
import type { VisionAdapter, VisionInput, VisionResult } from "../types";

const MOCK_MODEL = "mock-gemini-vision";
const MOCK_LABELS = ["packaging", "container", "product-photo"];

/** Deterministic Gemini vision stand-in: fixed label set plus a
 * content-derived fingerprint of the image bytes. */
export class MockVisionAdapter implements VisionAdapter {
  async classify(input: VisionInput): Promise<VisionResult> {
    return {
      labels: MOCK_LABELS,
      model: MOCK_MODEL,
      inputHash: fnv1aHex(`${input.mimeType}:${input.base64}`),
    };
  }
}
