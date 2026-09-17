import type { MergeDecision } from "./types";

const REPORT_HEADER = [
  "duplicate_line",
  "duplicate_name",
  "canonical_line",
  "canonical_name",
  "score",
  "name_similarity",
  "decision",
  "matched_signals",
  "merged_fields",
] as const;

function field(value: string | number): string {
  const raw = String(value);
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function maybeNumber(value: number | null): string {
  return value === null ? "" : value.toFixed(4);
}

/**
 * Renders the merge report CSV: one row per MERGE or REVIEW dedup decision,
 * in the order the importer emitted them (file order). Deterministic — same
 * decisions, same bytes.
 */
export function buildMergeReportCsv(decisions: readonly MergeDecision[]): string {
  const lines = [REPORT_HEADER.join(",")];
  for (const decision of decisions) {
    lines.push(
      [
        field(decision.duplicateLineNumber),
        field(decision.duplicateName),
        decision.canonicalLineNumber === null ? "" : field(decision.canonicalLineNumber),
        decision.canonicalName === null ? "" : field(decision.canonicalName),
        field(maybeNumber(decision.score)),
        field(maybeNumber(decision.nameSimilarity)),
        field(decision.decision),
        field(decision.matchedSignals.join(";")),
        field(decision.mergedFields.join(";")),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
