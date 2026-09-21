/**
 * Spec-compliance checking (spec: AI services — "Rules + Claude review —
 * flags claims without certification references (e.g., 'compostable' with no
 * cert doc), prompts the supplier to upload proof").
 *
 * Deterministic rules engine: a buyer's requirement set (attribute values
 * validated against a category's attribute set) is compared against the
 * attribute values of a listing, quote, or order subject, producing explicit
 * pass/fail/missing results with human-readable reasons. Sustainability-style
 * claims attached to the subject are flagged when they reference no
 * certification document — the supplier is prompted to upload proof, and
 * repeated flags surface in staff moderation. The reasoning adapter will add
 * narrative review on top at deploy time; the pass/fail decision itself stays
 * rule-based either way.
 *
 * Pure function: no database, no clock, no randomness — identical inputs
 * always produce the identical report.
 */
import type { AttributeJsonValue, AttributeValidationError, AttributeSet, ComplianceFramework, ListingAttributeValues } from "@packsource/db";
import { buildPartialAttributeSchema } from "@packsource/db";

/** The buyer's requirement: required attribute values plus their category's set. */
export interface ComplianceRequirement {
  attributeSet: AttributeSet;
  /** Required values — validated against `attributeSet` before the check runs. */
  values: ListingAttributeValues;
}

/** A sustainability-style claim attached to the subject (schema: ComplianceClaim). */
export interface ComplianceSubjectClaim {
  framework: ComplianceFramework;
  claim: string;
  certRef?: string | null;
  evidenceFileId?: string | null;
}

/** The listing / quote / order being checked. */
export interface ComplianceSubject {
  attributes?: ListingAttributeValues | null;
  claims?: ComplianceSubjectClaim[];
}

export type ComplianceCheckStatus = "pass" | "fail" | "missing";

export interface ComplianceCheck {
  key: string;
  label: string;
  status: ComplianceCheckStatus;
  required: AttributeJsonValue;
  actual: AttributeJsonValue | null;
  reason: string;
}

export interface ComplianceClaimFlag {
  framework: ComplianceFramework;
  claim: string;
  reason: string;
}

export interface ComplianceReport {
  /** All requirement checks pass AND no claim is missing its certification reference. */
  compliant: boolean;
  checks: ComplianceCheck[];
  claimFlags: ComplianceClaimFlag[];
}

/** Raised when the requirement values themselves violate the attribute set —
 * a malformed requirement is a caller bug, never a subject failure. */
export class ComplianceRequirementError extends Error {
  readonly invalidKeys: string[];

  constructor(
    message: string,
    invalidKeys: string[],
  ) {
    super(message);
    this.name = "ComplianceRequirementError";
    this.invalidKeys = invalidKeys;
  }
}

/** Canonical JSON so object values (dimensions) compare structurally. */
function canonical(value: AttributeJsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v as AttributeJsonValue)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry): entry is [string, AttributeJsonValue] => entry[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameValue(required: AttributeJsonValue, actual: AttributeJsonValue): boolean {
  return canonical(required) === canonical(actual);
}

/**
 * Checks a listing/quote/order subject against the buyer's requirement set.
 * Deterministic: identical requirement + subject → identical report.
 */
export function checkSpecCompliance(requirement: ComplianceRequirement, subject: ComplianceSubject): ComplianceReport {
  // Requirement values must themselves validate — requirements are wishes (a
  // buyer may specify only the keys they care about), but every specified key
  // must conform to the category's definitions. A requirement that violates
  // the attribute set is rejected loudly instead of producing guaranteed-fail
  // checks.
  const parsed = buildPartialAttributeSchema(requirement.attributeSet).safeParse(requirement.values);
  if (!parsed.success) {
    const invalidKeys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))].filter(Boolean);
    throw new ComplianceRequirementError(
      `requirement values violate the attribute set (${invalidKeys.join(", ")})`,
      invalidKeys,
    );
  }

  const attributes = subject.attributes ?? {};
  const definitionsByKey = new Map(requirement.attributeSet.attributes.map((d) => [d.key, d]));
  const checks: ComplianceCheck[] = [];

  for (const [key, required] of Object.entries(parsed.data) as [string, AttributeJsonValue][]) {
    const definition = definitionsByKey.get(key);
    const label = definition?.label ?? key;
    const actual = (attributes[key] ?? null) as AttributeJsonValue | null;
    if (actual === null || actual === undefined) {
      checks.push({
        key,
        label,
        status: "missing",
        required,
        actual: null,
        reason: `required ${label} is not present on the subject`,
      });
    } else if (sameValue(required, actual)) {
      checks.push({ key, label, status: "pass", required, actual, reason: `matches the required ${label}` });
    } else {
      checks.push({
        key,
        label,
        status: "fail",
        required,
        actual,
        reason: `required ${label} ${JSON.stringify(required)} but subject has ${JSON.stringify(actual)}`,
      });
    }
  }

  const claimFlags: ComplianceClaimFlag[] = (subject.claims ?? [])
    .filter((claim) => !claim.certRef && !claim.evidenceFileId)
    .map((claim) => ({
      framework: claim.framework,
      claim: claim.claim,
      reason: `claim "${claim.claim}" references no certification document — upload proof for ${claim.framework}`,
    }));

  return {
    compliant: checks.every((check) => check.status === "pass") && claimFlags.length === 0,
    checks,
    claimFlags,
  };
}

// Re-exported so callers can catch the DB package's error type without a
// direct dependency on its internals beyond the public surface.
export type { AttributeValidationError };
