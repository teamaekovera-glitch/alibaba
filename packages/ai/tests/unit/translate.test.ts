import { describe, expect, it } from "vitest";
import { MockLlmAdapter } from "../../src/mocks/llm";
import { TranslationInputError, translateMessage, translationCacheKey } from "../../src/services/translate";

/**
 * Chat translation (spec: AI services — per-message translation with cached
 * originals). Mock-mode contract: the deterministic adapter echo is the
 * stand-in translation; cache-key derivation and validation are real in
 * every mode.
 */

const LLM = new MockLlmAdapter();

describe("translateMessage", () => {
  it("is deterministic — same message and language, same result", async () => {
    const input = { text: "Can you quote 10,000 units by March?", targetLanguage: "es" };
    const first = await translateMessage(input, LLM);
    const second = await translateMessage(input, LLM);
    expect(second).toEqual(first);
  });

  it("returns the original alongside the translation for cached-original storage", async () => {
    const result = await translateMessage({ text: "Hello, what is the MOQ?", targetLanguage: "pt-BR" }, LLM);
    expect(result.original).toBe("Hello, what is the MOQ?");
    expect(result.translated.length).toBeGreaterThan(0);
    expect(result.model).toBe("mock-claude");
  });

  it("derives a stable cache key per original + language pair", async () => {
    const es = await translateMessage({ text: "Same text", targetLanguage: "es" }, LLM);
    const esAgain = await translateMessage({ text: "Same text", targetLanguage: "es" }, LLM);
    const pt = await translateMessage({ text: "Same text", targetLanguage: "pt-BR" }, LLM);
    expect(esAgain.cacheKey).toBe(es.cacheKey);
    expect(pt.cacheKey).not.toBe(es.cacheKey);
  });

  it("rejects empty messages and malformed language tags", async () => {
    await expect(translateMessage({ text: "   ", targetLanguage: "es" }, LLM)).rejects.toBeInstanceOf(
      TranslationInputError,
    );
    await expect(translateMessage({ text: "hello", targetLanguage: "not a tag!" }, LLM)).rejects.toBeInstanceOf(
      TranslationInputError,
    );
    await expect(
      translateMessage({ text: "hello", targetLanguage: "es", sourceLanguage: "42" }, LLM),
    ).rejects.toBeInstanceOf(TranslationInputError);
  });
});

describe("translationCacheKey", () => {
  it("is stable and collision-distinct across languages", () => {
    const key = translationCacheKey("Hola", "en");
    expect(key).toBe(translationCacheKey("Hola", "en"));
    expect(key).not.toBe(translationCacheKey("Hola", "fr"));
    expect(key.startsWith("tr_")).toBe(true);
  });
});
