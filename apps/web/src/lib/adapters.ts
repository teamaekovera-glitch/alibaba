import { MockMailAdapter, MockPaymentsAdapter, MockStorageAdapter } from "@packsource/ai";

/**
 * Process-wide mock adapter singletons. The Resend/R2/Stripe adapters will
 * replace these behind the same interfaces — nothing else in the app may
 * construct transports, storage clients, or payment clients directly.
 */
const globalForAdapters = globalThis as unknown as {
  mail?: MockMailAdapter;
  payments?: MockPaymentsAdapter;
  storage?: MockStorageAdapter;
};

export const mail: MockMailAdapter = globalForAdapters.mail ?? new MockMailAdapter();
export const payments: MockPaymentsAdapter =
  globalForAdapters.payments ?? new MockPaymentsAdapter();
export const storage: MockStorageAdapter = globalForAdapters.storage ?? new MockStorageAdapter();

if (process.env.NODE_ENV !== "production") {
  globalForAdapters.mail = mail;
  globalForAdapters.payments = payments;
  globalForAdapters.storage = storage;
}
