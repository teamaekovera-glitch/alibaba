# PackSource v1.0 — Implementation Summary

> **Status as of 2026-09-17** · branch `main` at `cc95afb85eea734bc64553a7ae79e83cf99ff88a` (PR #4)
> Governing spec: **PackSource v1.0 — packaging marketplace spec** (Blueprint artifact `art_tooqnEmJ`)
> Every number, SHA, file path, and job name in this document was read directly from the repository and the GitHub PR API — nothing is estimated.

---

## 1. Executive summary

**PackSource** is Aekovera's vertical B2B marketplace for food & beverage packaging: emerging CPG brands discover verified packaging suppliers, compare structured products and landed costs, run RFQs, negotiate terms, and buy with escrow-protected payments. It connects with Aekovera's supplier, co-manufacturer, and sourcing ecosystem (the `AekoveraProjectRef` and integration models).

**What exists today.** The repo is a greenfield pnpm 10.34.5 + Turborepo monorepo (Node 20+, TypeScript strict) with one Next.js 15 App Router application and four shared packages. Three of the planned build waves have landed as squash-merged PRs, each with green CI:

| # | Wave | Merge commit | Delivered |
|---|------|--------------|-----------|
| #2 | Monorepo scaffold | `2ab47cfb305f6602f5008f1cf824a06566b5daa0` | Workspaces, toolchain, mock-first adapter kit (10 adapters / 9 services), docker-compose, CI |
| #3 | Domain schema | `153d3730b95175878eabd1e59f294832f726d211` | Full Prisma 6 schema (60 models, 36 enums), nine-category packaging taxonomy, per-category Zod validation, pgvector/HNSW embeddings |
| #4 | Auth, RBAC, onboarding | `cc95afb85eea734bc64553a7ae79e83cf99ff88a` | Auth.js v5 (password + HMAC magic links), 7-role permission matrix with org-scoped repositories, six-step resumable supplier onboarding wizard, Playwright e2e |

**In flight.** PR #5 (`feat/importer-seed`, **open**) delivers the CSV migration importer and the deterministic fictional seed. The search-infrastructure workstream (`feat/search-infra`) is the next branch in progress.

**The one rule that shaped everything: mock-first.** `MOCK=true` is the default (also forced in CI). All nine external services — Claude, Gemini, Meilisearch, Stripe Connect, Resend, Pusher, R2/S3, EasyPost, Inngest — sit behind typed adapters with deterministic in-memory mocks (no `Math.random`, no `Date.now`, no network). The platform boots, tests, and demos with **zero API keys**. Real credentials attach at deploy time through the same interfaces.

The product surface live today is authentication and the supplier onboarding wizard; the RFQ → negotiation → order → escrow flows exist as a fully modeled domain (schema + status enums + Stripe adapter seam) awaiting their implementation waves.

---

## 2. PR index

All product PRs squash-merge to `main` after the two-job CI (`verify` + `integration`) goes green. Merge SHAs below are read from the GitHub API.

### PR #2 — feat: PackSource monorepo scaffold — workspaces, mock-first adapter kit, CI
- **State:** MERGED · **Branch:** `feat/scaffold-monorepo` · **Merge commit:** `2ab47cfb305f6602f5008f1cf824a06566b5daa0` · **Files changed:** 67
- **Delivered:**
  - Workspace layout: `apps/web` + `packages/{db,core,ai,ui}` under `pnpm-workspace.yaml`; Turborepo `turbo.json` with `build`/`dev`/`typecheck`/`test`/`test:integration` tasks (typecheck depends on upstream typecheck so `@packsource/core` resolves the generated Prisma client types through `@packsource/db`).
  - Toolchain: pnpm 10.34.5 (`packageManager`), Node 20+ engines, TypeScript strict via `tsconfig.base.json`, ESLint 9 flat config (`eslint.config.mjs`) with `@next/eslint-plugin-next` and react-hooks plugins, Prettier, `pnpm-lock.yaml` committed. pnpm 10 build-script allowlist (`onlyBuiltDependencies`) for the Prisma engine downloader, esbuild, and unrs-resolver binaries.
  - **Mock-first adapter kit** (`packages/ai`): typed interfaces for all ten adapters across nine external services (see §3), ten deterministic mock implementations, an FNV-1a hashing helper (`fnv.ts`) for deterministic value derivation, a `createAdapters(env)` factory that returns mocks unless `MOCK=false` (which raises `MockModeError` until real adapters are wired), and a 155-line contract test suite (`tests/unit/contract.test.ts`) that runs every mock against its interface.
  - `apps/web`: Next.js 15 + React 19 shell with a `/health` route; Tailwind v4 via PostCSS; `@packsource/ui` token-based component kit (`tokens.css`).
  - `docker-compose.yml` (pgvector Postgres 16), the two-job CI workflow (§5a), README, ignore/prettier configs.
  - Vitest 3 per workspace with paired `vitest.config.ts` (unit) and `vitest.integration.config.ts` (integration) configs; `.gitkeep` placeholders for suites that later waves add.

### PR #3 — feat(db): PackSource Prisma domain schema, packaging taxonomy, and attribute validation
- **State:** MERGED · **Branch:** `feat/domain-schema` · **Merge commit:** `153d3730b95175878eabd1e59f294832f726d211` · **Files changed:** 11
- **Delivered:**
  - `packages/db/prisma/schema.prisma` (~1,660 lines): **60 models and 36 enums** covering organizations/memberships, supplier profiles/plants/capabilities/equipment/certifications, category taxonomy, listings with variants/spec sheets/dielines/artwork/MOQ price tiers/lead-time rules/featured placements, the full RFQ → quote → negotiation trail, cart/sample kit/sample order, order → sub-order → shipment → invoice, payments/refunds/payouts/escrow ledger, disputes with evidence, messaging threads, reviews, fraud flags and rate limiting, buyer workspaces (saved lists, project boards, order templates, reorder rules, cost centers, PO numbers, approval requests), k-anonymized price benchmarks, `ListingEmbedding`, Aekovera project references, and webhook deliveries.
  - `prisma/migrations/20260917191824_init_domain_schema/migration.sql` (1,831 lines) — also creates the `vector` extension and the HNSW index; `migration_lock.toml` pins `postgresql`.
  - **Taxonomy** (`src/taxonomy/`): the nine top-level packaging categories locked by the spec, each with children and a per-category attribute-set JSON schema (§4); `flattenTaxonomy()`, `categoryDefinition()`, `attributeSetForSlug()` helpers.
  - **Attribute validation** (`src/attribute-validation.ts`, 159 lines): Zod schemas derived from the category attribute sets, strict (unknown keys rejected), with `AttributeValidationError` carrying the Zod issue list; a Zod meta-schema validates the attribute-set documents themselves.
  - Tests: `tests/integration/schema-roundtrip.test.ts` (569 lines — schema, taxonomy, and vector column against a real pgvector Postgres) and `tests/unit/attribute-validation-matrix.test.ts` (366 lines — per-category attribute validation matrix).

### PR #4 — feat: PackSource auth, RBAC permission gates, and supplier onboarding wizard
- **State:** MERGED · **Branch:** `feat/auth-onboarding` · **Merge commit:** `cc95afb85eea734bc64553a7ae79e83cf99ff88a` · **Files changed:** 35
- **Delivered:**
  - **Authentication** (`apps/web/src/auth.ts`, 147 lines): Auth.js v5 (`next-auth` 5.0.0-beta.32) with a credentials provider over scrypt password hashing (`lib/password.ts`) and HMAC-signed magic-link tokens (`lib/magic-link.ts`); JWT sessions carry organization membership and role claims; routes for `[...nextauth]`, `magic-link`, and `magic-callback`; a dev-only mock-mail inbox (`/api/dev/inbox`) backed by the mock Mail adapter.
  - **RBAC** (`packages/core/src/permissions.ts`, 180 lines): 7 roles, 19 `<domain>:<action>` permissions, and the role → permission matrix in one place — call sites never branch on role strings.
  - **Org-scoped repositories** (`packages/core/src/repositories.ts`, 541 lines): every domain query flows through permission-gated functions that filter by the acting user's `orgId` (§4).
  - **Onboarding wizard** (`packages/core/src/onboarding.ts` + `apps/web/src/app/onboarding/`): six steps, resumable, progress derived from persisted data; server actions (237 lines), step forms (393 lines), page (147 lines); nothing publicly visible until the profile is submitted for review.
  - Mock Payments adapter extension for Stripe Connect account linking (+19 lines to `mocks/payments.ts` and `types.ts`).
  - `packages/db/prisma/migrations/20260917200844_add_user_password_hash/migration.sql` + schema addition (`User.passwordHash`).
  - **E2E harness:** Playwright 1.63.0 (`playwright.config.ts`), `global-setup.ts` (applies Prisma migrations, idempotently seeds a supplier-ops user, starts Next.js with a deterministic test secret), and `wizard.spec.ts` (73 lines).
  - Tests: `org-scope.test.ts` integration (253 lines), `permissions.test.ts` unit (146 lines).

### PR #5 — feat(db): migration importer and deterministic fictional seed
- **State: OPEN (in flight)** — `mergeCommit` is `null`; the PR is open and being rebased onto `main` after PR #4 landed. **Branch:** `feat/importer-seed` · **Files changed (at time of reading):** 33
- **Delivers (per its open diff):**
  - **Migration importer** (`packages/db/src/importer/`): CSV column contract, parsing and row reading, normalization, taxonomy-aware deduplication with MERGE/REVIEW/NEW scoring (`dedup.ts`, `similarity.ts`), merge reports, transactional writes; `import-cli.ts` CLI entry; `docs/importer.md`; a fixture generator script and `fixtures/importer/sample-500.csv` (501 lines).
  - **Deterministic fictional seed** (`packages/db/src/seed/`): seeded RNG, fictional name pools, taxonomy-conformant attributes, placeholder images, demo dataset wiring; `seed-cli.ts` CLI entry.
  - Tests: `importer.test.ts` + `seed.test.ts` (integration), `dedup.test.ts` (unit); a `demo-banner.tsx` UI component + unit test in `packages/ui`.
- PR #5's importer enforces the importer default trust state (**UNVERIFIED**) for migrated suppliers — verification is a separate, later human process.

*(Repository housekeeping PR #1 — "Autobuild onboarding: .obvious contract for empty repository", branch `autobuild/onboarding` — is an empty-repo automation contract and not part of the product build.)*

---

## 3. Architecture

### 3.1 Monorepo layout

```
packsource/
├── apps/web/                 # Next.js 15 (App Router), React 19, Tailwind v4
│   ├── src/app/              # routes: /, /sign-in, /onboarding, /health
│   │   ├── api/auth/…        # Auth.js route handlers (magic link/callback)
│   │   ├── api/dev/inbox/    # dev-only mock-mail inbox
│   │   └── onboarding/       # wizard page, server actions, step forms
│   ├── src/auth.ts           # Auth.js v5 config (credentials + magic link)
│   ├── src/lib/              # adapters, db, magic-link, org-scoped, password
│   └── tests/                # unit (vitest), integration (vitest), e2e (playwright)
├── packages/db/              # Prisma 6 client, schema, migrations, taxonomy, Zod validation
├── packages/core/            # domain logic: permissions, repositories, onboarding rules
├── packages/ai/              # typed adapters + deterministic mocks for 9 services
├── packages/ui/              # Tailwind v4 component kit + design tokens
├── .github/workflows/ci.yml  # two-job CI (§5a)
├── docker-compose.yml        # local pgvector Postgres 16
├── turbo.json                # build / dev / typecheck / test / test:integration
└── pnpm-workspace.yaml       # apps/* + packages/*, build-script allowlist
```

Dependency direction: `web` → `core` → `db`; `web` → `ai`; `ui` is leaf-level. `packages/db` owns all persistence and persistence-adjacent validation; `packages/core` owns domain rules that never touch SQL directly (it goes through the repositories it also defines, which use the Prisma client from `db`).

### 3.2 The mock-first adapter kit (`packages/ai`)

Nine external services, ten typed adapters (Gemini supplies both Embedding and Vision). Every adapter has a deterministic in-memory mock; `createAdapters(env)` returns all ten mocks unless `MOCK=false`, which raises `MockModeError` until real providers exist. Determinism is contractual: mocks may not use `Math.random`, `Date.now`, or the network — identical call sequences produce identical results, and non-random values are derived through FNV-1a hashing.

| Adapter interface | External service | Role in the platform |
|---|---|---|
| `LlmAdapter` | Anthropic Claude | Spec extraction, conversational tooling |
| `EmbeddingAdapter` | Google Gemini | 1536-dim listing embeddings → pgvector |
| `VisionAdapter` | Google Gemini | Visual search / image classification |
| `SearchAdapter` | Meilisearch | Keyword/facet search index |
| `PaymentsAdapter` | Stripe Connect | Escrow holds (charges), releases (transfers), refunds |
| `MailAdapter` | Resend | Transactional email (mock inbox in dev) |
| `RealtimeAdapter` | Pusher | Realtime updates |
| `StorageAdapter` | Cloudflare R2 / S3 | Files: spec sheets, dielines, artwork, cert docs |
| `TrackingAdapter` | EasyPost | Shipment tracking |
| `QueueAdapter` | Inngest | Background jobs |

The Stripe seam deserves a note: the adapter exposes *separate charges and transfers* — capture to the platform balance is the escrow hold, transfer to the supplier's connected account is the release, refunds draw from the platform balance. The escrow state machine in `packages/core` decides when these fire; **the ledger stays the source of truth** (`EscrowLedgerEntry` is append-only).

### 3.3 Multi-tenant org model

- Every domain table carries `orgId` for tenant isolation. Two documented platform-global exceptions: the `Category` taxonomy and the k-anonymized `PriceBenchmark` aggregates.
- Roles attach to `OrgMembership`, not to users: the same person can be a `BUYER` in one organization and `SUPPLIER_SALES` in another. A permission check always happens against one membership's role.
- Three org types (`OrgType`): `BUYER`, `SUPPLIER`, `PLATFORM`.
- Seven roles (`OrgRole`): buyer-side `OWNER`, `ADMIN`, `BUYER`, `APPROVER`; supplier-side `SUPPLIER_SALES`, `SUPPLIER_OPS`; platform `AEKOVERA_STAFF`.
- 19 permissions named `<domain>:<action>` — buyer-side (`catalog:search`, `workspace:manage`, `rfq:create`, `rfq:manage`, `cart:manage`, `order:create`, `order:approve`, `sample:order`), supplier-side (`supplier:onboard`, `profile:manage`, `listing:manage`, `quote:create`, `shipment:manage`), platform staff (`supplier:verify`, `moderation:manage`, `dispute:mediate`, `placement:manage`), and shared (`analytics:view`, `message:send`).
- Enforcement lives in `packages/core`: the role → permission matrix is central (call sites never branch on role strings), and every domain query flows through permission-gated repository functions that filter by the acting user's `orgId`. Postgres row-level security is a planned *hardening* step, not the primary gate.
- Supplier trust ladder (`VerificationStatus`): `UNVERIFIED` (importer default) → `VERIFIED` (documents) → `AEKOVERA_VETTED` (site/reference check); status boosts search rank.

### 3.4 Architecture diagram

```mermaid
graph TB
    subgraph client["Browser"]
        B["Buyer / Supplier UI"]
    end

    subgraph web["apps/web — Next.js 15 App Router"]
        PAGES["/sign-in · /onboarding · / · /health"]
        ACTIONS["Server Actions"]
        AUTHJS["Auth.js v5<br/>scrypt passwords + HMAC magic links<br/>JWT with org/role claims"]
    end

    subgraph core["packages/core — domain rules"]
        PERM["permissions.ts<br/>7 roles × 19 permissions matrix"]
        REPOS["repositories.ts<br/>permission-gated, org-scoped queries"]
        ONB["onboarding.ts<br/>six-step derived progress"]
    end

    subgraph db["packages/db — Prisma 6"]
        SCHEMA["schema.prisma<br/>60 models · 36 enums"]
        TAX["taxonomy/<br/>9 categories + attribute sets"]
        ZOD["attribute-validation.ts<br/>strict per-category Zod"]
        MIG["migrations/<br/>init_domain_schema + password_hash"]
    end

    subgraph ai["packages/ai — adapter kit (MOCK=true default)"]
        FACT["createAdapters(env)"]
        subgraph mocks["10 deterministic mocks"]
            M["llm · embedding · vision · search · payments<br/>mail · realtime · storage · tracking · queue"]
        end
    end

    PG[("PostgreSQL 16 + pgvector<br/>HNSW cosine index<br/>docker-compose locally · Neon in prod")]
    SVC["9 external services<br/>Claude · Gemini · Meilisearch · Stripe Connect<br/>Resend · Pusher · R2 · EasyPost · Inngest"]

    B --> PAGES
    B --> AUTHJS
    PAGES --> ACTIONS --> REPOS
    AUTHJS --> PERM --> REPOS
    ONB --> REPOS
    REPOS --> SCHEMA
    SCHEMA --> PG
    MIG --> PG
    TAX --> ZOD --> SCHEMA
    web --> FACT
    FACT --> M
    FACT -. "MOCK=false at deploy time (not yet wired)" .-> SVC
    PG -. "vector extension + HNSW via $queryRaw" .-> SCHEMA
```

---

## 4. Domain model (`packages/db/prisma/schema.prisma`)

**Scale:** 60 models, 36 enums, two migrations. Conventions stated in the schema header and enforced in code:

- **Org tenancy.** Every domain table carries `orgId`; queries go through permission-gated repository functions that filter by org (§3.3). The two platform-global exceptions (`Category`, k-anonymized `PriceBenchmark`) are documented on the models.
- **Money is integer cents everywhere** (`*Cents` fields: `minOrderValueCents`, `amountCents`, price tiers, payment and payout amounts, and so on); **rates are integer basis points** (`*Bps`). No floats touch money.
- **State is enum-typed** per the spec — 36 enums including `RfqMode`/`RfqStatus`, `QuoteStatus`, `NegotiationMessageKind`, `OrderStatus`/`SubOrderStatus`, `PaymentKind`/`PaymentStatus`, `RefundStatus`, `PayoutStatus`, `EscrowEntryKind`, `InvoiceKind`/`InvoiceStatus`, `ShipmentStatus`, `DisputeStatus`/`DisputeOutcome`, `VerificationStatus`, `ListingStatus`, `SpecExtractionStatus`, `ComplianceFramework`, `EmbeddingKind`, `WebhookDirection`/`WebhookDeliveryStatus`.
- **Append-only tables** (`AuditLog`, `EscrowLedgerEntry`) deliberately have no `updatedAt`.
- **pgvector embeddings.** `ListingEmbedding.embedding` is a `vector` column (1536 dimensions, HNSW cosine index). Prisma cannot express either natively, so the init migration creates the extension and the HNSW index, and access is via `$queryRaw` (proven by the schema-roundtrip integration test).

### Nine packaging categories

`TOP_LEVEL_CATEGORY_COUNT = 9` (`packages/db/src/taxonomy/categories.ts`):

| # | Slug | Name | Children |
|---|------|------|----------|
| 0 | `rigid` | Rigid | Glass Bottles, Jars, Cans, PET Bottles, HDPE Bottles |
| 1 | `flexible` | Flexible | Stand-Up Pouches, Spouted Pouches, Sachets, Films, Roll Stock |
| 2 | `paperboard` | Paperboard | Folding Cartons, Rigid Boxes |
| 3 | `corrugated` | Corrugated | — |
| 4 | `closures-caps` | Closures & Caps | — |
| 5 | `labels-shrink-sleeves` | Labels & Shrink Sleeves | — |
| 6 | `trays-clamshells` | Trays & Clamshells | — |
| 7 | `secondary-tertiary` | Secondary & Tertiary | — |
| 8 | `sustainable-compostable` | Sustainable & Compostable | — |

Each category carries an **attribute-set JSON schema** (`Category.attributeSet`) built from shared attribute builders: `material` (per-category enum, required), `dimensions` (L×W×H, required), `volumeMl` (ml, required where applicable), `printMethod` (multi-enum: OFFSET, DIGITAL, FLEXO, SCREEN, HOT_STAMP, PAD_PRINT, NONE), `printColors` (0–12), `finish` (MATTE, GLOSS, SOFT_TOUCH, METALLIC, UNFINISHED), `recyclability` (WIDELY_RECYCLABLE / CHECK_LOCALLY / NOT_RECYCLABLE), OTR oxygen and WVTR moisture **barrier** ratings (LOW/MEDIUM/HIGH, required only where shelf life depends on them), and `foodContact` (FOOD_GRADE / NON_FOOD_GRADE, required only for food-contact categories). Category-specific attributes add e.g. `neckFinish`, `boardWeightGsm`, `coating`, `wallType`, `fluting`, `applicationMethod`, `adhesiveType`, `compartmentCount` (1–24), `compostStandard`, `recycledContentPct`.

**Per-category Zod validation** (`packages/db/src/attribute-validation.ts`): validators are *derived from* the category attribute sets, so schema and validation can't drift. Validation is **strict — unknown keys are rejected** — listings cannot carry attributes outside their category's schema, satisfying the spec acceptance criterion "attribute values rejected when violating a category's attribute set." A Zod meta-schema (`attributeSetSchema`, strict) validates the attribute-set documents themselves; violations raise `AttributeValidationError` with the full Zod issue list.

**Sustainability is dual-natured:** `sustainable-compostable` is a category *and* a cross-cutting flag — listings in any category may carry `RECYCLABLE` / `COMPOSTABLE` compliance claims (`Listing.complianceClaims`) while the dedicated category holds the assortment.

---

## 5. Workflows

### 5a. CI — `.github/workflows/ci.yml` (as merged in PR #2, on `main` today)

**Workflow name:** `CI`. **Triggers:** every `pull_request`, plus `push` to `main`. **Concurrency:** one run per `workflow + ref` group with `cancel-in-progress: true` (a new push cancels the superseded run). **Workflow-level env:** `MOCK: "true"` — CI always runs mock-first.

**Job 1 — `verify`** (`name: lint + typecheck + test + build`, `ubuntu-latest`):

| Step | Command / action |
|------|------------------|
| Checkout | `actions/checkout@v4` |
| pnpm setup | `pnpm/action-setup@v4` |
| Node + cache | `actions/setup-node@v4` — `node-version: 20`, `cache: pnpm` |
| Install dependencies | `pnpm install --frozen-lockfile` |
| Lint | `pnpm lint` (ESLint 9 flat config, whole repo) |
| Typecheck | `pnpm typecheck` (Turbo, upstream-first so Prisma client types exist) |
| Unit tests | `pnpm test` (Turbo → Vitest per workspace) |
| Build | `pnpm build` (Turbo → Next.js build; caches `.next/**` + `dist/**`) |

**Job 2 — `integration`** (`name: integration (pgvector service)`, `ubuntu-latest`): runs the integration suites against a **real pgvector Postgres** in a service container — wired for the integration suites later workstreams add (Prisma repositories, importer, seeder determinism, search-index sync):

- **Service container:** `postgres` → image `pgvector/pgvector:pg16`, env `POSTGRES_USER: packsource`, `POSTGRES_PASSWORD: packsource`, `POSTGRES_DB: packsource_test`, port `5432:5432`, health options `pg_isready -U packsource -d packsource_test` every 5s (5s timeout, 10 retries).
- **Job env:** `DATABASE_URL: postgresql://packsource:packsource@localhost:5432/packsource_test`.
- Steps: checkout → `pnpm/action-setup@v4` → `actions/setup-node@v4` (node 20, pnpm cache) → `pnpm install --frozen-lockfile` → **"Verify pgvector extension availability"** (`psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'` then `SELECT extname FROM pg_extension; | grep -q vector` — proves the service container is genuinely pgvector-enabled) → **"Integration suites (passWithNoTests until suites land)"** (`pnpm test:integration`; `passWithNoTests` keeps the job green until suites exist, while the extension check pins the container's capability).

Both jobs run on every PR in this repo, including this docs PR.

### 5b. Product workflows

**Merged and live today:** sign-in (password + magic link), the six-step supplier onboarding wizard, publish-after-submit visibility, org/RBAC plumbing. **Blueprint spec (`art_tooqnEmJ`), for later waves:** everything downstream of onboarding — listings, RFQs, negotiation, orders, escrow. The diagrams below mark which is which.

#### Supplier onboarding (merged — PR #4)

Six steps in wizard order: `company` → `plants` → `certifications` → `equipment` → `terms` → `payments`. Progress is **derived from what the wizard has already persisted**, not from a client-side pointer: each step writes its rows as they are completed, so a supplier who leaves and comes back resumes exactly where the data says they are (`firstIncomplete`). Nothing is publicly visible until the profile is submitted for review (`isPubliclyVisible`, `submittedForReviewAt`).

```mermaid
flowchart TD
    S0["Sign in — password or magic link<br/>(merged: Auth.js v5, mock Mail in dev)"] --> C["1 · Company details<br/>writes SupplierProfile"]
    C --> PL["2 · Plants & locations<br/>writes Plant rows"]
    PL --> CE["3 · Certifications<br/>uploads documents via mock Storage<br/>writes Certification rows"]
    CE --> EQ["4 · Equipment & capabilities<br/>writes Equipment + Capability rows"]
    EQ --> TE["5 · MOQ & payment terms<br/>writes profile MOQ + PaymentTerms"]
    TE --> PA["6 · Stripe Connect account<br/>links via mock Payments adapter"]
    PA --> SUB["Submit for review<br/>submittedForReviewAt set"]
    SUB --> LOCK["Profile locked — submitted panel<br/>Aekovera review queue (verification itself is a later wave)"]
    C -. "reload any time: progress derived<br/>from persisted data, not session" .-> RESUME["Resume at firstIncomplete step"]
    RESUME -.-> C
```

The Playwright e2e (`wizard.spec.ts`) asserts exactly this path — password sign-in, all six steps through the real UI and server actions (mock Storage + mock Stripe Connect), reload-resume mid-wizard, submission, and the locked submitted panel — with zero API keys.

#### RFQ → quote/negotiation → order → escrow release (Blueprint spec — later waves)

The full domain for this path is **merged** (models and status enums from PR #3): `Rfq` + `RfqLine`, `Quote` + `QuoteLine`, `NegotiationMessage`, `Cart`/`CartItem`/`SampleKit`/`SampleOrder`, `Order`/`SubOrder`/`OrderLine`, `Shipment`, `Invoice`, `Payment`, `Refund`, `Payout`, `EscrowLedgerEntry`, `Dispute`. The **application flows are not implemented yet** — they are the spec's later waves (listings browse/detail, RFQ console, negotiation threads, checkout, escrow state machine). The Stripe adapter seam (hold = charge to platform balance, release = transfer, refund) and the append-only ledger are the merged foundation that flow implementation will code against.

```mermaid
flowchart TD
    subgraph RFQ["spec — later wave"]
        A["Buyer creates RFQ<br/>(Rfq + RfqLines, RfqMode/RfqStatus)"]
        B["Suppliers respond with Quotes<br/>(Quote + QuoteLines, QuoteStatus)"]
        C{"Negotiation<br/>(NegotiationMessage thread)"}
        A --> B --> C
        C -- "terms agreed" --> D["Buyer orders — Order + SubOrder per supplier<br/>(OrderStatus / SubOrderStatus)"]
        D --> E["Payment captured to platform balance<br/>= ESCROW HOLD (mock Payments adapter)"]
        E --> F["Suppliers ship — Shipment tracking<br/>(mock Tracking adapter)"]
        F --> G["Buyer receives; escrow state machine releases<br/>= TRANSFER to supplier connected account"]
        G --> H["Payout + Invoice; EscrowLedgerEntry written<br/>(append-only — the source of truth)"]
        C -- "blocked" --> I["Dispute + DisputeEvidence<br/>(DisputeStatus / DisputeOutcome)"]
        I --> J["Refund / Payout resolution<br/>(RefundStatus / PayoutStatus)"]
    end
    M1["Merged foundation: schema models + enums (PR #3)<br/>+ Stripe adapter seam (PRs #2/#4)"] -.->|"implemented against"| RFQ
```

---

## 6. Test matrix

Actual file counts on `origin/main` (verified by listing the tree; PR #5's open additions listed separately):

| Layer | Suite | Files on `main` | Location |
|---|---|---|---|
| Unit | Vitest | **7** | `apps/web/tests/unit/smoke.test.ts` · `packages/ai/tests/unit/contract.test.ts` (155 lines — every mock against its interface) · `packages/core/tests/unit/permissions.test.ts` (146) · `packages/core/tests/unit/smoke.test.ts` · `packages/db/tests/unit/attribute-validation-matrix.test.ts` (366) · `packages/db/tests/unit/smoke.test.ts` · `packages/ui/tests/unit/smoke.test.ts` |
| Integration | Vitest (`vitest.integration.config.ts`, needs pgvector Postgres) | **2** | `packages/core/tests/integration/org-scope.test.ts` (253) · `packages/db/tests/integration/schema-roundtrip.test.ts` (569) |
| E2E | Playwright 1.63.0 (`pnpm test:e2e` in `apps/web`) | **1 spec** | `apps/web/tests/e2e/wizard.spec.ts` (73) + `global-setup.ts` (56 — migrations, idempotent supplier-ops seed, Next.js with deterministic secret) |
| **Total on `main`** | | **10 files** | 9 `*.test.ts` + 1 `*.spec.ts` |
| *Open PR #5 adds* | | *+4 files* | `packages/db/tests/unit/dedup.test.ts` (198) · `packages/db/tests/integration/importer.test.ts` (109) · `packages/db/tests/integration/seed.test.ts` (172) · `packages/ui/tests/unit/demo-banner.test.ts` (28) |

Notes:
- Every workspace has paired unit + integration Vitest configs (from PR #2), so future suites slot into both CI jobs; `packages/ai` and `packages/ui` carry `.gitkeep` placeholders in `tests/integration/`.
- The integration suites hit a real pgvector Postgres (CI service container; docker-compose locally). Unit suites are DB-independent.
- E2E coverage is the onboarding happy path with resume and submission-lock assertions (§5b).

---

## 7. Running locally — zero API keys

Everything below is from the real `package.json` / `docker-compose.yml` / workspace scripts on `main`. `MOCK=true` is the default everywhere; **no API keys are needed to boot, test, or demo.** (`MOCK=false` intentionally raises `MockModeError` until real provider adapters are wired.)

```bash
# 0. Prereqs: Node >= 20, pnpm 10.34.5 (root package.json "packageManager")
corepack enable                       # or: npm install -g pnpm@10.34.5

# 1. Install (packages/db postinstall runs `prisma generate`)
pnpm install

# 2. Postgres 16 + pgvector (container: packsource-db, user/pass packsource, db packsource)
docker compose up -d db               # healthcheck: pg_isready -U packsource -d packsource

# 3. Point DATABASE_URL at it (repo does not commit an .env.example; only DATABASE_URL is needed)
export DATABASE_URL=postgresql://packsource:packsource@localhost:5432/packsource

# 4. Apply the two committed migrations (no dedicated migrate script on main yet —
#    use the Prisma CLI directly from packages/db)
pnpm --filter @packsource/db exec prisma migrate deploy
#    20260917191824_init_domain_schema  (1,831 lines; creates vector extension + HNSW index)
#    20260917200844_add_user_password_hash

# 5. Seed + importer CLIs land with PR #5 (open): packages/db/src/cli/seed-cli.ts and
#    import-cli.ts, plus script entries in packages/db/package.json — not on main yet.

# 6. Run
pnpm dev                # turbo run dev → web at http://localhost:3000 (health at /health)
pnpm lint               # eslint .
pnpm typecheck          # turbo run typecheck
pnpm test               # unit suites (DB-independent)
pnpm test:integration   # integration suites against the pgvector Postgres
pnpm build              # turbo run build
pnpm format:check       # prettier --check .
# E2E (apps/web):
pnpm --filter @packsource/web test:e2e   # playwright test
```

| Command (root `package.json`) | Script |
|---|---|
| `pnpm dev` | `turbo run dev` |
| `pnpm build` | `turbo run build` |
| `pnpm lint` | `eslint .` |
| `pnpm typecheck` | `turbo run typecheck` |
| `pnpm test` | `turbo run test` |
| `pnpm test:integration` | `turbo run test:integration` |
| `pnpm format` / `format:check` | `prettier --write .` / `prettier --check .` |

Dev-mail: outbound email goes to the mock Mail adapter; read it at `/api/dev/inbox` in the web app.

---

## 8. In flight and next

**In flight now:**
- **PR #5 — `feat(db): migration importer and deterministic fictional seed`** (`feat/importer-seed`): **open** — the CSV migration importer (column contract, normalization, taxonomy-aware dedup with MERGE/REVIEW/NEW scoring, merge reports, transactional writes), the deterministic fictional seed (seeded RNG, fictional names, taxonomy-conformant attributes, placeholder images, demo dataset), CLI entries, fixtures, and its test files. It is being rebased onto `main` following PR #4's merge; this document intentionally describes it as open/in-flight until it merges.
- **Search infrastructure workstream** (`feat/search-infra`): Meilisearch facets/filtering, pgvector semantic + hybrid ranking, visual search via the Vision adapter, index synchronization, and a Postgres-outage fallback that degrades gracefully — next branch in progress after the importer wave.

**Remaining roadmap workstreams** (per the approved spec, Blueprint `art_tooqnEmJ`, in the spec's wave order):
1. **Listings** — supplier listing authoring and buyer browse/detail surfaces over the category/attribute foundation (schema merged; UI pending).
2. **RFQ → quote → negotiation → order → escrow release** — the trade loop of §5b against the already-merged models, enums, and Stripe adapter seam, including the escrow state machine in `packages/core` (README commits core to "pricing & landed cost, escrow state machine, permissions"; the latter two ship so far).
3. **Buyer workspaces** — saved lists, project boards, order templates, reorder rules, cost centers, PO numbers, approval flows (models merged).
4. **Trust & verification operations** — Aekovera review queue, document verification (`VERIFIED`), site/reference vetting (`AEKOVERA_VETTED`), moderation, dispute mediation.
5. **Logistics** — shipments, tracking, invoices (models merged; adapters mocked).
6. **Aekovera OS integration** — `AekoveraProjectRef`, webhook deliveries, platform analytics.
7. **Real provider adapters** — implement the same ten interfaces behind `MOCK=false` env switching at deploy time (the seam is already the contract).
8. **Postgres row-level security** — hardening layer on top of the repository-level org gates (explicitly a hardening step, not the primary gate, per `permissions.ts`).

---

*Prepared from the repository state at `cc95afb` and the GitHub PR API on 2026-09-17. Sources: `git log origin/main`, `git ls-tree -r origin/main`, `gh pr list/view` for #2–#5, `.github/workflows/ci.yml`, `docker-compose.yml`, root/workspace `package.json` files, `turbo.json`, `pnpm-workspace.yaml`, `packages/db/prisma/schema.prisma`, `packages/db/src/taxonomy/*`, `packages/db/src/attribute-validation.ts`, `packages/ai/src/{types,createAdapters}.ts`, `packages/core/src/{permissions,onboarding}.ts`, and the test files listed in §6.*
