import { jaroWinkler } from "./similarity";
import { normalizeCity, normalizeCompanyName, normalizeDomain, normalizePhone } from "./normalize";

/**
 * Fuzzy dedup scoring over the documented signals: normalized company name
 * (weighted Jaro-Winkler similarity), normalized city (exact), normalized
 * domain (exact), and normalized phone (exact).
 *
 * A weighted score would alone be brittle at the threshold boundary, so the
 * decision is the conjunction of a floor on the name similarity and the
 * weighted score:
 *
 *   MERGE  score >= MERGE_THRESHOLD     AND nameSimilarity >= NAME_MERGE_FLOOR
 *   REVIEW REVIEW_THRESHOLD <= score < MERGE_THRESHOLD
 *   NEW    score < REVIEW_THRESHOLD
 *
 * MERGE rows collapse into their canonical org; REVIEW rows import as their
 * own org but are surfaced in the merge report for human review.
 */

export const NAME_WEIGHT = 0.6;
export const CITY_WEIGHT = 0.15;
export const DOMAIN_WEIGHT = 0.15;
export const PHONE_WEIGHT = 0.1;

export const MERGE_THRESHOLD = 0.85;
export const REVIEW_THRESHOLD = 0.7;
/** A weak name match must never merge, however strong the other signals are. */
export const NAME_MERGE_FLOOR = 0.85;

export type DedupDecisionKind = "MERGE" | "REVIEW" | "NEW";

export type DedupSignal = "name" | "city" | "domain" | "phone";

/** Normalized comparison inputs for one CSV row. */
export interface DedupFingerprint {
  lineNumber: number;
  name: string;
  normalizedName: string;
  city: string;
  normalizedCity: string;
  domain: string | null;
  phoneKey: string | null;
}

export interface PairScore {
  /** Weighted score in [0, 1], rounded to 4 decimals for reporting. */
  score: number;
  nameSimilarity: number;
  /** Signals that matched for this pair (domain/phone count only when both sides have a value). */
  matchedSignals: DedupSignal[];
}

export function fingerprintRow(row: {
  lineNumber: number;
  name: string;
  city: string;
  domain: string | null;
  phone: string | null;
}): DedupFingerprint {
  return {
    lineNumber: row.lineNumber,
    name: row.name,
    normalizedName: normalizeCompanyName(row.name),
    city: row.city,
    normalizedCity: normalizeCity(row.city),
    domain: normalizeDomain(row.domain),
    phoneKey: normalizePhone(row.phone),
  };
}

export function scorePair(a: DedupFingerprint, b: DedupFingerprint): PairScore {
  const nameSimilarity = jaroWinkler(a.normalizedName, b.normalizedName);
  const cityMatch =
    a.normalizedCity !== "" && b.normalizedCity !== "" && a.normalizedCity === b.normalizedCity;
  const domainMatch = a.domain !== null && b.domain !== null && a.domain === b.domain;
  const phoneMatch = a.phoneKey !== null && b.phoneKey !== null && a.phoneKey === b.phoneKey;

  const score =
    NAME_WEIGHT * nameSimilarity +
    (cityMatch ? CITY_WEIGHT : 0) +
    (domainMatch ? DOMAIN_WEIGHT : 0) +
    (phoneMatch ? PHONE_WEIGHT : 0);

  const matchedSignals: DedupSignal[] = [];
  // Name always contributes to the score, so it is always a matched signal.
  matchedSignals.push("name");
  if (cityMatch) matchedSignals.push("city");
  if (domainMatch) matchedSignals.push("domain");
  if (phoneMatch) matchedSignals.push("phone");

  return { score: round4(score), nameSimilarity: round4(nameSimilarity), matchedSignals };
}

export function decideDedup(pair: Pick<PairScore, "score" | "nameSimilarity">): DedupDecisionKind {
  if (pair.score >= MERGE_THRESHOLD && pair.nameSimilarity >= NAME_MERGE_FLOOR) return "MERGE";
  if (pair.score >= REVIEW_THRESHOLD) return "REVIEW";
  return "NEW";
}

/** Blocking keys for a fingerprint — dedup only compares rows sharing a key. */
export function blockingKeys(fingerprint: DedupFingerprint): string[] {
  const keys: string[] = [];
  if (fingerprint.normalizedCity !== "") keys.push(`city:${fingerprint.normalizedCity}`);
  if (fingerprint.domain !== null) keys.push(`domain:${fingerprint.domain}`);
  if (fingerprint.phoneKey !== null) keys.push(`phone:${fingerprint.phoneKey}`);
  return keys;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
