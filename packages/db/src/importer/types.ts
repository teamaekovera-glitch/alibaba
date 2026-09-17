/**
 * Shared importer types (kept separate so pure modules can import them
 * without pulling in the Prisma client).
 */

import type { DedupDecisionKind } from "./dedup";

/** One dedup decision that lands in the merge report. */
export interface MergeDecision {
  decision: Extract<DedupDecisionKind, "MERGE" | "REVIEW">;
  duplicateLineNumber: number;
  duplicateName: string;
  /** Canonical row the duplicate merged into; null when the decision is REVIEW. */
  canonicalLineNumber: number | null;
  canonicalName: string | null;
  score: number;
  nameSimilarity: number;
  matchedSignals: string[];
  /** Fields backfilled from the duplicate into the canonical (MERGE only). */
  mergedFields: string[];
}

export interface ImportSummary {
  /** Data rows read from the file (excluding the header). */
  inputRowCount: number;
  /** Rows that became orgs (NEW + REVIEW rows after dedup). */
  importedOrgCount: number;
  /** Rows merged into another row's org. */
  mergedRowCount: number;
  /** Rows imported as their own org but flagged for human review. */
  reviewRowCount: number;
  errorRows: { lineNumber: number; column: string | null; message: string }[];
  decisions: MergeDecision[];
}
