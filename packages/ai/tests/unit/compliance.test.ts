import { describe, expect, it } from "vitest";
import { attributeSetForSlug } from "@packsource/db";
import {
  checkSpecCompliance,
  ComplianceRequirementError,
  type ComplianceSubjectClaim,
} from "../../src/services/compliance";

/**
 * Spec-compliance checking (spec: AI services — compliance checker). The
 * rules engine compares a buyer's requirement set against a listing/quote/
 * order subject with explicit pass/fail/missing reasons, and flags claims
 * that reference no certification document.
 */

/** Minimal synthetic set — the documented attribute dialect, no taxonomy coupling. */
const SET = {
  version: 1 as const,
  attributes: [
    { key: "material", label: "Material", type: "enum" as const, required: true, options: ["PET", "HDPE"] },
    {
      key: "dimensions",
      label: "Dimensions (L×W×H)",
      type: "dimensions" as const,
      required: false,
    },
    { key: "printColors", label: "Print colors", type: "integer" as const, required: false, min: 0, max: 12 },
  ],
};

const REQUIREMENT = { attributeSet: SET, values: { material: "PET", printColors: 2 } };

describe("checkSpecCompliance", () => {
  it("passes when every required value matches, structurally for objects", () => {
    const report = checkSpecCompliance(REQUIREMENT, {
      attributes: { material: "PET", printColors: 2, dimensions: { lengthMm: 40, widthMm: 40, heightMm: 120 } },
    });
    expect(report.compliant).toBe(true);
    expect(report.checks.map((c) => c.status)).toEqual(["pass", "pass"]);
    expect(report.claimFlags).toEqual([]);
  });

  it("treats dimension objects as equal regardless of key order", () => {
    const report = checkSpecCompliance(
      { attributeSet: SET, values: { dimensions: { lengthMm: 40, widthMm: 40, heightMm: 120 } } },
      { attributes: { dimensions: { heightMm: 120, lengthMm: 40, widthMm: 40 } } },
    );
    expect(report.checks[0]?.status).toBe("pass");
    expect(report.compliant).toBe(true);
  });

  it("reports an explicit fail with both sides in the reason", () => {
    const report = checkSpecCompliance(REQUIREMENT, { attributes: { material: "HDPE", printColors: 2 } });
    expect(report.compliant).toBe(false);
    const material = report.checks.find((c) => c.key === "material");
    expect(material?.status).toBe("fail");
    expect(material?.reason).toBe('required Material "PET" but subject has "HDPE"');
  });

  it("reports a missing attribute distinctly from a failing one", () => {
    const report = checkSpecCompliance(REQUIREMENT, { attributes: { material: "PET" } });
    const colors = report.checks.find((c) => c.key === "printColors");
    expect(colors?.status).toBe("missing");
    expect(colors?.reason).toBe("required Print colors is not present on the subject");
    expect(report.compliant).toBe(false);
  });

  it("checks a real category set end to end (rigid)", () => {
    const rigid = attributeSetForSlug("rigid");
    if (!rigid) throw new Error("rigid taxonomy vanished");
    const report = checkSpecCompliance(
      { attributeSet: rigid, values: { material: "PET", hotFillCapable: true } },
      { attributes: { material: "PET", hotFillCapable: false } },
    );
    expect(report.checks.find((c) => c.key === "hotFillCapable")?.status).toBe("fail");
  });

  it("flags claims without certification references and prompts for proof", () => {
    const claims: ComplianceSubjectClaim[] = [
      { framework: "COMPOSTABLE", claim: "100% compostable" },
      { framework: "FSC", claim: "FSC-certified paperboard", certRef: "FSC-C-123456" },
      { framework: "RECYCLABLE", claim: "widely recyclable", evidenceFileId: "file_9" },
    ];
    const report = checkSpecCompliance(REQUIREMENT, { attributes: { material: "PET", printColors: 2 }, claims });
    expect(report.compliant).toBe(false);
    expect(report.claimFlags).toHaveLength(1);
    expect(report.claimFlags[0]?.framework).toBe("COMPOSTABLE");
    expect(report.claimFlags[0]?.reason).toContain("upload proof");
  });

  it("is compliant when requirements pass and all claims carry references", () => {
    const report = checkSpecCompliance(REQUIREMENT, {
      attributes: { material: "PET", printColors: 2 },
      claims: [{ framework: "FSC", claim: "chain of custody", certRef: "FSC-C-1" }],
    });
    expect(report.compliant).toBe(true);
  });

  it("rejects malformed requirements loudly instead of producing guaranteed-fail checks", () => {
    expect(() =>
      checkSpecCompliance({ attributeSet: SET, values: { material: "UNOBTANIUM" } }, { attributes: {} }),
    ).toThrow(ComplianceRequirementError);
    expect(() =>
      checkSpecCompliance({ attributeSet: SET, values: { noSuchKey: 1 } }, { attributes: {} }),
    ).toThrow(ComplianceRequirementError);
  });

  it("is deterministic — identical inputs produce the identical report", () => {
    const subject = { attributes: { material: "HDPE" }, claims: [{ framework: "KOSHER" as const, claim: "kosher" }] };
    expect(checkSpecCompliance(REQUIREMENT, subject)).toEqual(checkSpecCompliance(REQUIREMENT, subject));
  });
});
