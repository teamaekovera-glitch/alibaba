/**
 * Chat translation (spec: AI services — "Per-message translation with cached
 * originals for non-English suppliers; email fallback carries the same
 * policy").
 *
 * Mock-mode contract: the Claude adapter performs the translation itself, so
 * in mock mode the "translation" is the adapter's deterministic stand-in —
 * same input message + language, same output, zero API keys. The service owns
 * the parts that are real in every mode: input validation, the cache-key
 * derivation callers use to store and reuse translations per original
 * message, and provenance. Deploy-time credentials swap the adapter without
 * touching this pipeline.
 */
import { fnv1aHex } from "../fnv";
import type { LlmAdapter } from "../types";

/** Raised when a translation request is structurally invalid. */
export class TranslationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationInputError";
  }
}

export interface TranslationInput {
  text: string;
  /** BCP-47-ish target language tag, e.g. "es", "zh-Hans", "pt-BR". */
  targetLanguage: string;
  /** Source language tag when known (advisory context for the adapter). */
  sourceLanguage?: string;
}

export interface TranslationResult {
  original: string;
  translated: string;
  targetLanguage: string;
  /** Stable cache key — callers key stored translations by this. */
  cacheKey: string;
  /** Translation-adapter model identifier (provenance). */
  model: string;
}

/** Language tags: 2-8 letter subtags joined by hyphens ("es", "zh-Hans"). */
const LANGUAGE_TAG_PATTERN = /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8})*$/;

/**
 * Stable cache key for an original message + target language. Deterministic:
 * the same original always caches under the same key per language, so a
 * translated thread re-reads its cached originals instead of re-translating.
 */
export function translationCacheKey(text: string, targetLanguage: string): string {
  return `tr_${fnv1aHex(`${targetLanguage}:${text}`)}`;
}

/**
 * Translates one marketplace message through the reasoning adapter. The
 * original is returned alongside so callers can persist both (spec: "cached
 * originals") and re-render either side of the thread.
 */
export async function translateMessage(input: TranslationInput, llm: LlmAdapter): Promise<TranslationResult> {
  const text = input.text;
  if (text.trim().length === 0) {
    throw new TranslationInputError("message text is empty");
  }
  if (!LANGUAGE_TAG_PATTERN.test(input.targetLanguage)) {
    throw new TranslationInputError(`invalid target language tag: ${input.targetLanguage}`);
  }
  if (input.sourceLanguage !== undefined && !LANGUAGE_TAG_PATTERN.test(input.sourceLanguage)) {
    throw new TranslationInputError(`invalid source language tag: ${input.sourceLanguage}`);
  }

  const sourceContext = input.sourceLanguage ? ` (from ${input.sourceLanguage})` : "";
  const response = await llm.complete({
    system:
      "You are PackSource's marketplace translation engine. Translate the user's message faithfully, preserving quantities, prices, and product terms.",
    messages: [{ role: "user", content: `Translate to ${input.targetLanguage}${sourceContext}: ${text}` }],
  });

  return {
    original: text,
    translated: response.text,
    targetLanguage: input.targetLanguage,
    cacheKey: translationCacheKey(text, input.targetLanguage),
    model: response.model,
  };
}
