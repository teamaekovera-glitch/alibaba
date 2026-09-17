# Migration importer — CSV column contract

`packages/db` ships a CLI that imports supplier organizations from a flat CSV
file (Aekovera's migration source: the 12,000-supplier database export, Pack
Expo list, and related flat files). The file format is a **contract**: the
importer validates headers strictly and rejects files that do not match it.

```
pnpm --filter @packsource/db import -- --file <path.csv> [--report <path.csv>]
```

- `--file` — path to the CSV (required)
- `--report` — path for the merge report (default `./import-merge-report.csv`)

## Column contract

Source of truth: [`src/importer/column-contract.ts`](../src/importer/column-contract.ts).
The header row is matched case-insensitively after trimming.

| Column | Type | Required | Lands in | Notes |
| --- | --- | --- | --- | --- |
| `name` | string | **yes** | `Organization.name` | Legal or trading name. |
| `city` | string | **yes** | `Plant.city` | Primary plant city. |
| `state` | string | no | `Plant.state` | State / province / region. |
| `country` | string | no | `Plant.country` | ISO-3166 alpha-2; defaults to `US`. |
| `email` | email | no | `Organization.billingEmail` | Invalid addresses fail the row. |
| `phone` | phone | no | *(not persisted)* | **Dedup signal only.** PackSource gates supplier contact details behind quote acceptance (trust rules), so raw phone numbers are never stored. |
| `domain` | domain | no | *(not persisted)* | **Dedup signal only.** Bare host (`acme.example`); protocols/paths are stripped during normalization. |
| `categories` | string list | no | `Capability` rows | Semicolon-separated taxonomy slugs (top-level or child, e.g. `rigid;flexible`). Known slugs become `category:<slug>` capabilities; unknown slugs produce a **warning** and are skipped. |
| `certifications` | string list | no | `Capability` rows | Semicolon-separated claimed types (e.g. `SQF;BRCGS`). Stored as `claimed-cert:<TYPE>` capabilities — deliberately **not** `Certification` records, which require document evidence and belong to the verification workflow. |
| `about` | string | no | `SupplierProfile.about` | Free text. |

Notes:

- `contactName`-style columns are intentionally absent: the schema does not
  store named supplier contacts (contact details are revealed only after quote
  acceptance or verified-buyer status, per the trust rules in the spec).
- The importer creates `Organization` (type `SUPPLIER`), one `SupplierProfile`,
  one primary `Plant`, and the capability rows above. It does **not** create
  `User` records — suppliers claim their organization through the auth
  onboarding flow later.

## Error semantics

- **File-level (fatal, exit code 1):** file unreadable; header missing a
  required column (`name`, `city`); header containing an unknown column;
  database failure. Nothing is imported.
- **Row-level (skipped, exit code 2):** missing `name`/`city`; malformed
  `email` / `phone` / `country` values. The row is skipped, the error is
  reported on stderr and in the summary; all valid rows still import.
- **Warnings (non-fatal):** unknown `categories` slugs — the value is dropped
  and a warning is emitted; the row still imports.

Import is not idempotent across runs: re-importing the same file fails on
unique-slug conflicts (orgs are deduplicated *within* a file, not against
previously imported data — cross-file dedup is future work).

## Deduplication

Rows are scored pairwise on **normalized** signals:

| Signal | Comparison | Weight |
| --- | --- | --- |
| Company name | Jaro-Winkler similarity of the normalized name (lowercase, punctuation removed, legal suffixes like `Inc`/`LLC`/`Co`/`Corp` dropped) | 0.60 |
| City | exact match of the normalized city | 0.15 |
| Domain | exact match of the normalized host | 0.15 |
| Phone | exact match on the last 10 digits | 0.10 |

Decisions (`src/importer/dedup.ts`):

- **MERGE** — score ≥ 0.85 **and** name similarity ≥ 0.85. The duplicate row
  does not become an org; fields the canonical row is missing are backfilled
  from the duplicate (`email`, `about`, `categories`, `certifications`) and the
  moved fields are recorded in the report.
- **REVIEW** — score ≥ 0.70 but below the merge bar. The row imports as its
  own organization and is flagged in the merge report for human review.
- **NEW** — score < 0.70: an independent organization.

The name-similarity floor prevents weak name matches from merging on the
strength of shared city/domain alone. Candidate comparisons are blocked by
normalized city, domain, or phone so scoring scales linearly.

## Merge report

Every MERGE and REVIEW decision is written to the merge report CSV
(`--report`), one row per decision:

`duplicate_line, duplicate_name, canonical_line, canonical_name, score, name_similarity, decision, matched_signals, merged_fields`

`matched_signals` is a `;`-separated subset of `name;city;domain;phone`;
`merged_fields` lists the fields backfilled from the duplicate into the
canonical org.

## Verification guarantee

Every imported `SupplierProfile` is hard-set to `UNVERIFIED`
(`VerificationStatus.UNVERIFIED`). There is no column, flag, or code path in
the importer that can produce `VERIFIED` or `AEKOVERA_VETTED` — those tiers
are granted only through the staff verification workflow. The importer
re-reads its writes after insertion and fails loudly if any imported profile
is not `UNVERIFIED`.
