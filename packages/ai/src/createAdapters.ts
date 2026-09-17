import { MockEmbeddingAdapter } from "./mocks/embedding";
import { MockLlmAdapter } from "./mocks/llm";
import { MockMailAdapter } from "./mocks/mail";
import { MockPaymentsAdapter } from "./mocks/payments";
import { MockQueueAdapter } from "./mocks/queue";
import { MockRealtimeAdapter } from "./mocks/realtime";
import { MockSearchAdapter } from "./mocks/search";
import { MockStorageAdapter } from "./mocks/storage";
import { MockTrackingAdapter } from "./mocks/tracking";
import { MockVisionAdapter } from "./mocks/vision";
import type { Adapters } from "./types";

/** Raised when MOCK=false is requested before real provider adapters exist. */
export class MockModeError extends Error {}

/**
 * Build the adapter bundle. MOCK=true (or unset — the default) returns the
 * deterministic in-memory mocks, so build, test, and demo run with zero API
 * keys. MOCK=false raises until real provider adapters are wired in later
 * workstreams; they will implement these same interfaces behind env-var
 * switching, per the spec's adapter seam.
 */
export function createAdapters(env: Record<string, string | undefined> = process.env): Adapters {
  const mock = env["MOCK"] !== "false";
  if (!mock) {
    throw new MockModeError(
      "MOCK=false requested, but real provider adapters are not implemented in this workstream. " +
        "Build and test always run with MOCK=true; real credentials are configured at deploy time.",
    );
  }
  return {
    llm: new MockLlmAdapter(),
    embedding: new MockEmbeddingAdapter(),
    vision: new MockVisionAdapter(),
    search: new MockSearchAdapter(),
    payments: new MockPaymentsAdapter(),
    mail: new MockMailAdapter(),
    realtime: new MockRealtimeAdapter(),
    storage: new MockStorageAdapter(),
    tracking: new MockTrackingAdapter(),
    queue: new MockQueueAdapter(),
  };
}
