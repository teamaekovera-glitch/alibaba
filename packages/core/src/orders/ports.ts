/**
 * Ports the order workflow depends on. Structural interfaces mirroring the
 * adapter types in @packsource/ai (the web layer injects the mock or real
 * adapters); packages/core never constructs clients itself (spec: "All nine
 * external services sit behind typed adapters... MOCK=true is the default
 * and the only mode in build/test").
 */
import type { PaymentsAdapter, StorageAdapter } from "@packsource/ai";

/** Payments port — the Stripe Connect seam (separate charges and transfers). */
export type OrderPaymentsPort = PaymentsAdapter;

/** Storage port — the R2 seam used for invoice PDFs. */
export type OrderStoragePort = StorageAdapter;

/** Everything the order workflow can call out to. */
export interface OrderPorts {
  payments: OrderPaymentsPort;
  storage: OrderStoragePort;
}
