import {
  MockLlmAdapter,
  MockMailAdapter,
  MockPaymentsAdapter,
  MockStorageAdapter,
  MockTrackingAdapter,
  MockVisionAdapter,
} from "@packsource/ai";

/**
 * Process-wide mock adapter singletons. The Resend/R2/Stripe adapters will
 * replace these behind the same interfaces — nothing else in the app may
 * construct transports, storage clients, or payment clients directly.
 */
const globalForAdapters = globalThis as unknown as {
  mail?: MockMailAdapter;
  payments?: MockPaymentsAdapter;
  storage?: MockStorageAdapter;
  vision?: MockVisionAdapter;
  llm?: MockLlmAdapter;
  tracking?: MockTrackingAdapter;
};

export const mail: MockMailAdapter = globalForAdapters.mail ?? new MockMailAdapter();
export const payments: MockPaymentsAdapter =
  globalForAdapters.payments ?? new MockPaymentsAdapter();
export const storage: MockStorageAdapter = globalForAdapters.storage ?? new MockStorageAdapter();
// Reasoning (Claude) and vision (Gemini) mocks: deterministic, keyless stand-ins
// for the listing extraction pipelines. Suggestions they produce are always
// human-reviewable before save — nothing extracted is trusted by default.
export const vision: MockVisionAdapter = globalForAdapters.vision ?? new MockVisionAdapter();
export const llm: MockLlmAdapter = globalForAdapters.llm ?? new MockLlmAdapter();
// Carrier tracking mock: deterministic tracking numbers and events behind the
// same interface an EasyPost client will implement.
export const tracking: MockTrackingAdapter = globalForAdapters.tracking ?? new MockTrackingAdapter();

if (process.env.NODE_ENV !== "production") {
  globalForAdapters.mail = mail;
  globalForAdapters.payments = payments;
  globalForAdapters.storage = storage;
  globalForAdapters.vision = vision;
  globalForAdapters.llm = llm;
  globalForAdapters.tracking = tracking;
}
