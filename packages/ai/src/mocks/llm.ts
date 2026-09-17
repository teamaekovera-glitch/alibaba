import type { LlmAdapter, LlmRequest, LlmResponse } from "../types";

const MOCK_MODEL = "mock-claude";
const PROMPT_PREVIEW_CHARS = 72;

/** Deterministic Claude stand-in: echoes a structured completion derived from
 * the request. No randomness, no network — same input, same output. */
export class MockLlmAdapter implements LlmAdapter {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const prompt = request.messages.map((m) => m.content).join("\n");
    const system = request.system ?? "";
    const preview = prompt.slice(0, PROMPT_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
    const maxTokens = request.maxTokens ?? 1024;
    return {
      text: `[mock:${MOCK_MODEL}] ${system ? `(${system}) ` : ""}${preview}`,
      model: MOCK_MODEL,
      stopReason: "end_turn",
      inputTokens: countTokens(system + prompt),
      outputTokens: Math.min(countTokens(preview) + 4, maxTokens),
    };
  }
}

function countTokens(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}
