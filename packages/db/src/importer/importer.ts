import type { PrismaClient } from "@prisma/client";
import { parseCsv } from "./parse-csv";
import { readImportRows } from "./read-rows";
import { blockingKeys, decideDedup, fingerprintRow, scorePair } from "./dedup";
import type { DedupFingerprint, PairScore } from "./dedup";
import type { ImportRow } from "./read-rows";
import type { ImportSummary, MergeDecision } from "./types";
import { slugify } from "./normalize";

/**
 * Migration importer: reads CSV rows matching the documented column contract
 * (docs/importer.md), deduplicates near-identical supplier rows, and writes
 * Organization + SupplierProfile + Plant + Capability rows.
 *
 * Invariants (spec: trust rules):
 *   - Every imported SupplierProfile is hard-set to UNVERIFIED. There is no
 *     parameter, column, or code path that imports at a higher tier; the
 *     write is followed by a re-read assertion that fails loudly if any
 *     imported profile is not UNVERIFIED.
 *   - Every MERGE / REVIEW decision is reported in the returned summary so
 *     the caller can emit the merge report CSV.
 */

export async function importSuppliersCsv(
  client: PrismaClient,
  csvText: string,
): Promise<ImportSummary> {
  const csv = parseCsv(csvText);
  const { rows, errors } = readImportRows(csv);

  // ── Dedup pass ────────────────────────────────────────────────────────────
  // Rows are processed in file order; the first occurrence of a company is
  // canonical. Candidates are restricted to accepted rows sharing a blocking
  // key (normalized city, domain, or phone) so scoring stays O(n · block).

  const rowsByLine = new Map<number, ImportRow>();
  const fingerprints = new Map<number, DedupFingerprint>();
  for (const row of rows) {
    rowsByLine.set(row.lineNumber, row);
    fingerprints.set(
      row.lineNumber,
      fingerprintRow({
        lineNumber: row.lineNumber,
        name: row.name,
        city: row.city,
        domain: row.domain,
        phone: row.phone,
      }),
    );
  }

  const accepted = new Map<number, DedupFingerprint>();
  const blockIndex = new Map<string, Set<number>>();
  const decisions: MergeDecision[] = [];

  const orderedRows = [...rows].sort((a, b) => a.lineNumber - b.lineNumber);

  for (const row of orderedRows) {
    const fingerprint = fingerprints.get(row.lineNumber);
    if (fingerprint === undefined) continue;

    const candidateLines = new Set<number>();
    for (const key of blockingKeys(fingerprint)) {
      const bucket = blockIndex.get(key);
      if (bucket === undefined) continue;
      for (const line of bucket) {
        if (accepted.has(line)) candidateLines.add(line);
      }
    }

    let best: { line: number; pair: PairScore } | null = null;
    for (const line of candidateLines) {
      const candidate = accepted.get(line);
      if (candidate === undefined) continue;
      const pair = scorePair(fingerprint, candidate);
      if (best === null || pair.score > best.pair.score) {
        best = { line, pair };
      }
    }

    const kind = best === null ? "NEW" : decideDedup(best.pair);

    if (best !== null && kind === "MERGE") {
      const canonical = rowsByLine.get(best.line);
      if (canonical !== undefined) {
        const mergedFields = backfillCanonical(canonical, row);
        decisions.push({
          decision: "MERGE",
          duplicateLineNumber: row.lineNumber,
          duplicateName: row.name,
          canonicalLineNumber: best.line,
          canonicalName: canonical.name,
          score: best.pair.score,
          nameSimilarity: best.pair.nameSimilarity,
          matchedSignals: best.pair.matchedSignals,
          mergedFields,
        });
        // Merged rows do not become orgs, so they are not dedup targets.
        continue;
      }
    }

    if (best !== null && kind === "REVIEW") {
      // Ambiguous near-duplicate: imports as its own org, flagged for review.
      decisions.push({
        decision: "REVIEW",
        duplicateLineNumber: row.lineNumber,
        duplicateName: row.name,
        canonicalLineNumber: null,
        canonicalName: null,
        score: best.pair.score,
        nameSimilarity: best.pair.nameSimilarity,
        matchedSignals: best.pair.matchedSignals,
        mergedFields: [],
      });
    }

    accepted.set(row.lineNumber, fingerprint);
    for (const key of blockingKeys(fingerprint)) {
      const bucket = blockIndex.get(key);
      if (bucket === undefined) {
        blockIndex.set(key, new Set([row.lineNumber]));
      } else {
        bucket.add(row.lineNumber);
      }
    }
  }

  const importedRows = [...accepted.keys()]
    .map((line) => rowsByLine.get(line))
    .filter((row): row is ImportRow => row !== undefined)
    .sort((a, b) => a.lineNumber - b.lineNumber);

  // ── Persistence ───────────────────────────────────────────────────────────
  // Deterministic, line-traceable ids: every imported row can be matched back
  // to its CSV line via the id.

  const usedSlugs = new Set<string>();
  const orgRows = importedRows.map((row) => {
    const base = `${slugify(row.name)}-${slugify(row.city)}`;
    let slug = base;
    while (usedSlugs.has(slug)) slug = `${base}-${row.lineNumber}`;
    usedSlugs.add(slug);
    return {
      id: `imported_org_line_${row.lineNumber}`,
      type: "SUPPLIER" as const,
      name: row.name,
      slug,
      billingEmail: row.email,
    };
  });

  const profileRows = importedRows.map((row) => ({
    id: `imported_profile_line_${row.lineNumber}`,
    orgId: `imported_org_line_${row.lineNumber}`,
    // Hard default — the only tier the importer can produce (spec: trust rules).
    verificationStatus: "UNVERIFIED" as const,
    about: row.about,
  }));

  const plantRows = importedRows.map((row) => ({
    id: `imported_plant_line_${row.lineNumber}`,
    orgId: `imported_org_line_${row.lineNumber}`,
    supplierProfileId: `imported_profile_line_${row.lineNumber}`,
    name: "Primary plant",
    city: row.city,
    state: row.state,
    country: row.country,
    isPrimary: true,
  }));

  const capabilityRows = importedRows.flatMap((row) => {
    const orgId = `imported_org_line_${row.lineNumber}`;
    const profileId = `imported_profile_line_${row.lineNumber}`;
    const categoryCaps = row.categories.map((slug) => ({
      id: `imported_cap_line_${row.lineNumber}_cat_${slug.replace(/[^a-zA-Z0-9]/g, "-")}`,
      orgId,
      supplierProfileId: profileId,
      name: `category:${slug}`,
      detail: "Imported from migration CSV",
    }));
    const certCaps = row.certifications.map((cert) => ({
      id: `imported_cap_line_${row.lineNumber}_cert_${cert.replace(/[^a-zA-Z0-9]/g, "-")}`,
      orgId,
      supplierProfileId: profileId,
      name: `claimed-cert:${cert}`,
      detail: "Claimed in migration CSV; unverified pending documentation",
    }));
    return [...categoryCaps, ...certCaps];
  });

  await client.$transaction(async (tx) => {
    await tx.organization.createMany({ data: orgRows });
    await tx.supplierProfile.createMany({ data: profileRows });
    await tx.plant.createMany({ data: plantRows });
    if (capabilityRows.length > 0) {
      await tx.capability.createMany({ data: capabilityRows });
    }
  });

  // ── Invariant check ───────────────────────────────────────────────────────
  const orgIds = orgRows.map((row) => row.id);
  const profiles = await client.supplierProfile.findMany({
    where: { orgId: { in: orgIds } },
    select: { orgId: true, verificationStatus: true },
  });
  if (profiles.length !== orgIds.length) {
    throw new Error(
      `Import invariant violated: expected ${orgIds.length} supplier profiles, found ${profiles.length}.`,
    );
  }
  for (const profile of profiles) {
    if (profile.verificationStatus !== "UNVERIFIED") {
      throw new Error(
        `Import invariant violated: org ${profile.orgId} imported as ${profile.verificationStatus} — ` +
          "the importer must only ever produce UNVERIFIED profiles.",
      );
    }
  }

  return {
    inputRowCount: csv.rows.length,
    importedOrgCount: orgRows.length,
    mergedRowCount: decisions.filter((d) => d.decision === "MERGE").length,
    reviewRowCount: decisions.filter((d) => d.decision === "REVIEW").length,
    errorRows: errors,
    decisions,
  };
}

/** Fills gaps on the canonical row from the merged duplicate; reports what moved. */
function backfillCanonical(canonical: ImportRow, duplicate: ImportRow): string[] {
  const mergedFields: string[] = [];
  if (canonical.email === null && duplicate.email !== null) {
    canonical.email = duplicate.email;
    mergedFields.push("email");
  }
  if (canonical.about === null && duplicate.about !== null) {
    canonical.about = duplicate.about;
    mergedFields.push("about");
  }
  for (const slug of duplicate.categories) {
    if (!canonical.categories.includes(slug)) {
      canonical.categories.push(slug);
      if (!mergedFields.includes("categories")) mergedFields.push("categories");
    }
  }
  for (const cert of duplicate.certifications) {
    if (!canonical.certifications.includes(cert)) {
      canonical.certifications.push(cert);
      if (!mergedFields.includes("certifications")) mergedFields.push("certifications");
    }
  }
  return mergedFields;
}
