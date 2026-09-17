import { hashToUnit } from "../fnv";
import type { EmbeddingAdapter, EmbeddingResponse } from "../types";

const MOCK_MODEL = "mock-gemini-embedding";
const DIMENSIONS = 8;

/** Deterministic Gemini embedding stand-in: an 8-dim vector hashed from the
 * text. Same text always yields the same vector. */
export class MockEmbeddingAdapter implements EmbeddingAdapter {
  async embed(text: string): Promise<EmbeddingResponse> {
    return { vector: embedFor(text), model: MOCK_MODEL, dimensions: DIMENSIONS };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResponse[]> {
    return texts.map((t) => ({ vector: embedFor(t), model: MOCK_MODEL, dimensions: DIMENSIONS }));
  }
}

function embedFor(text: string): number[] {
  return Array.from({ length: DIMENSIONS }, (_, axis) => hashToUnit(text, axis));
}
