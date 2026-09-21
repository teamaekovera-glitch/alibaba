# PackSource v1.0 — Implementation Summary

> **Status as of 2026-09-21 — build complete.** `main` at `eabbc5b3c1e598a851a8711548385a3ff57b768f` (PR #17). The build closed with the QA/documentation PR (#16), followed by the post-close RFQ-creation fix (PR #17).
> Governing spec: **PackSource v1.0 — packaging marketplace spec** (Blueprint artifact `art_tooqnEmJ`)
> Every number, SHA, file path, and job name in this document was read directly from the repository and the GitHub PR API this session — nothing is estimated.

---

## 1. Executive summary

**PackSource** is Aekovera's vertical B2B marketplace for food & beverage packaging: emerging CPG brands discover verified packaging suppliers, compare structured products and landed costs, run RFQs, negotiate terms, and buy with escrow-protected payments. It connects with Aekovera's supplier, co-manufacturer, and sourcing ecosystem (the `AekoveraProjectRef` and integration models).

**What exists today.** The repo is a greenfield pnpm 10.34.5 + Turborepo monorepo (Node 20+, TypeScript strict) with one Next.js 15 App Router application and **ten shared packages**. Every build wave from the approved spec has landed as a squash-merged PR with green CI, followed by the closing QA/documentation PR and one post-close RFQ fix:

| # | Wave | Merge commit | Delivered |
|---|------|--------------|-----------|
| #2 | Monorepo scaffold | `2ab47cfb305f6602f5008f1cf824a06566b5daa0` | Workspaces, toolchain, mock-first adapter kit (10 adapters / 9 services), docker-compose, CI |
| #3 | Domain schema | `153d3730b95175878eabd1e59f294832f726d211` | Prisma 6 schema (63 models, 38 enums after #13/#14), nine-category packaging taxonomy, per-category Zod validation, pgvector/HNSW embeddings |
| #4 | Auth, RBAC, onboarding | `cc95afb85eea734bc64553a7ae79e83cf99ff88a` | Auth.js v5 (password + HMAC magic links), 7-role permission matrix with org-scoped repositories, six-step resumable supplier onboarding wizard |
| #5 | Importer & seed | `b9119768cd2171a20f3aff4e3cc249d9bcc3f141` | CSV migration importer (dedup with MERGE/REVIEW/NEW scoring) and the deterministic fictional seed |
| #6 | Docs | `b69f0970624bb97d062d559fc14a33fa65482b96` | First implementation summary, test matrix, local runbook |
| #7 | Search | `44e4a869b5d9e8a961390ac6509d745779f96521` | Meilisearch facets, pgvector semantic/hybrid ranking, visual search, Postgres-outage fallback |
| #8 | RFQ engine | `0e8fc76c9fd752ea1cebf8cec8a390804a3420fc` | RFQs, quotes, negotiation, quote cart with landed cost |
| #9 | Listings | `d6babcae05d6b83bb8a62e6ea31f9727f2afe8ca` | Supplier listing editors, bulk import, human-reviewed AI extraction |
| #10 | Storefront | `fbfd90020da60d80d7034d57cc5528f699324253` | Buyer storefront — faceted search, product pages, compare, supplier and co-man surfaces |
| #11 | Orders & escrow | `be1932b941c954b0344a83e16857056be06647be` | Order lifecycle, Stripe Connect mock escrow (30/70), invoices, shipments, payouts |
| #12 | CI hardening | `71b707a710a4e520bf0449fbe6dd8b29b5c79550` | Bounded Postgres readiness gate, order-independent integration suite handoffs |
| #13 | Admin & notifications | `f2a64ff3fc30d2c0b6e1cb93549ab4c0bb4a2ed9` | Staff admin console (verification, moderation, disputes, placements, audit/export) and the notification domain |
| #14 | Trust | `b0b780fefe35df838dee040eef5fd36ae83447c0` | Buyer-supplier messaging, verified-purchase reviews + responses + aggregates, dispute lifecycle with evidence and withdrawal, fraud controls |
| #15 | AI & integrations | `302d035e5dd18a7e3f1053894c85f72adb14cd75` | Listing-extraction AI services, k-anonymous benchmarks, HMAC-signed Aekovera OS webhooks, read-only org-scoped agent API, SEO metadata/JSON-LD/robots/sitemap |
| #16 | **Closing: E2E QA + docs** | `c11d977afbeb4b259e7be204b1e0567d36d8b742` | Playwright e2e suite over the deterministic seed (9 tests, 5 specs), dedicated `e2e` CI job, this final-state documentation |
| #17 | RFQ creation fix | `eabbc5b3c1e598a851a8711548385a3ff57b768f` | RFQ form category selection + SINGLE-listing mode (deep links inherit the category), typed matching errors, UI-created RFQs sendable with supplier matches — 12 files changed, new `rfq-ui-create.spec.ts` (3 e2e tests) and `rfq-form.test.ts` (18 unit tests) |

**The one rule that shaped everything: mock-first.** `MOCK=true` is the default (also forced in CI). All nine external services — Claude, Gemini, Meilisearch, Stripe Connect, Resend, Pusher, R2/S3, EasyPost, Inngest — sit behind typed adapters with deterministic in-memory mocks (no `Math.random`, no `Date.now`, no network). The platform boots, tests, demos, and **runs its entire e2e suite with zero API keys**. Real credentials attach at deploy time through the same interfaces.

**The full trade loop is live and e2e-verified end to end:** buyer discovers a supplier in faceted/semantic search → product page with landed-cost economics → RFQ → supplier quote → counter-offer negotiation → award → 30/70 payments (deposit, production, balance) → shipment with mock-carrier tracking → supplier delivery confirmation → automatic escrow release → platform-staff payout settlement — plus the trust layer (messaging, verified-purchase reviews, disputes with mediation), the staff admin console with notifications, k-anonymous benchmarks, a signed webhook channel to Aekovera OS, and a read-only agent API.

---

## 2. PR index

All product PRs squash-merge to `main` after CI goes green. Merge SHAs below are read from the GitHub PR API.

- **State key:** all PRs #2–#17 MERGED; #17 is the latest (merged 2026-09-21).

### PR #5 — feat(db): migration importer and deterministic fictional seed
- **Delivered:** CSV migration importer (`packages/db/src/importer/`): column contract, normalization, taxonomy-aware dedup scoring (MERGE/REVIEW/NEW), merge reports, transactional writes. Deterministic fictional seed (`packages/db/src/seed/`, `pnpm --filter @packsource/db seed`): seeded RNG, fictional org/user names, taxonomy-conformant attributes, placeholder images, 1,500 listings across 150 supplier orgs, 60 workflow orders, 30 reviews — recreated identically on every run via `seed_*`-prefixed id wipes. CLI entries in `packages/db/src/cli/` (`seed-cli.ts`, `import-cli.ts`). Tests: importer integration, seed determinism, dedup unit matrix.

### PR #6 — docs: implementation summary
- **Delivered:** the first version of this document (PR history through #5, architecture, CI workflows, test matrix, local runbook), `docs/importer.md` companion.

### PR #7 — feat(search): search infrastructure
- **Delivered:** `packages/search` — Meilisearch keyword/facet adapter with deterministic mock, pgvector semantic + hybrid ranking, visual search via the Vision adapter, index synchronization, and a Postgres-outage fallback that degrades to in-memory retrieval. Exposes the `/api/search` route the storefront consumes.

### PR #8 — feat(rfq): RFQ engine, quotes, negotiation, quote cart
- **Delivered:** RFQ create/sent/inbox/detail surfaces, quote submission with landed-cost preview, negotiation threads (quote revisions mark predecessors `SUPERSEDED`), quote cart, buyer award through the Order-Quote relation, RBAC-gated supplier actions.

### PR #9 — feat(listings): supplier listing management
- **Delivered:** draft editor with per-category attribute forms, bulk CSV import, AI spec-sheet extraction (`packages/ai` LlmAdapter + `SpecExtractionStatus` lifecycle) with human confirmation before suggestions apply, submit-for-review transition (`DRAFT → PENDING_REVIEW`).

### PR #10 — feat(storefront): buyer storefront
- **Delivered:** faceted search over `/api/search` with the Postgres fallback, product pages with full landed-cost economics, four-item compare cookie (`packsource_compare`) and `/compare` table, supplier profiles and co-manufacturer surfaces, seeded discovery.

### PR #11 — feat(orders): order lifecycle, escrow, invoices, shipments, payouts
- **Delivered:** the 30/70 order machine (`DRAFT → DEPOSIT_DUE → DEPOSIT_PAID → IN_PRODUCTION → READY_TO_SHIP → BALANCE_DUE → SHIPPED → DELIVERED → ESCROW_RELEASED`, with `CANCELED`/dispute paths), deposit and balance invoices, payments against outstanding invoices, shipment creation through the mock EasyPost adapter, supplier delivery confirmation firing automatic escrow release, supplier payouts (net of commission) with staff settlement, buyer/supplier order detail surfaces (schedule, payments, escrow, invoices, shipments, disputes).

### PR #12 — fix(ci): integration job hardening
- **Delivered:** bounded Postgres readiness gate (30 × 2s with an explicit `::error` on timeout) replacing unguarded first-touch, extension verification, order-independent integration suite handoffs. The readiness-gate pattern is reused verbatim by the e2e job (PR #16).

### PR #13 — feat(admin): staff admin console and notification domain
- **Delivered:** `packages/notifications` (typed notification domain, inbox surfaces) and the staff admin console — supplier verification, moderation, dispute mediation, featured placements, org access, audit log, CSV export. Adds `admin:access` and `payout:view/settle` permissions (22 total now).

### PR #14 — feat(trust): messaging, reviews, disputes, fraud controls
- **Delivered:** buyer-supplier messaging threads with read state, verified-purchase reviews anchored to delivered order lines with supplier responses and aggregate ratings, dispute lifecycle (open with evidence, discussion, buyer withdrawal, staff mediation, refund/payout outcomes), review moderation state, fraud controls and rate limiting. Schema additions ship as the `trust_*` and `review_order_line_anchor` migrations.

### PR #15 — feat(ai): AI services, benchmarks, webhooks, agent API, SEO
- **Delivered:** `packages/benchmarks` (k-anonymous price-benchmark aggregates), `packages/integrations` (HMAC-signed Aekovera OS webhook deliveries), `packages/agent-api` (read-only, org-scoped agent API for listings/suppliers/search), `packages/seo` (canonical metadata, Open Graph, Product/Organization JSON-LD, robots, sitemap), and deterministic AI listing-extraction services. `/api/agent` routes.

### PR #16 — test(e2e): closing QA suite and final documentation
- **Delivered:** the Playwright e2e suite (§6), the dedicated `e2e` CI job (§5a), this final-state document and README.

### PR #17 — fix(rfq): category selection, single-listing mode, and typed matching errors
- **Delivered:** the fix for the RFQ-creation defect PR #16 first reported (§8, resolved): the RFQ form gains a category selector and a SINGLE-listing mode — product-page deep links mount the form with the listing's category context (`rfq-listing-context.ts`, new: the shared server loader behind both the dashboard mount and the create action; only LIVE listings yield context) — form parsing (`rfq-form.ts`, new: pure FormData → `CreateRfqInput` functions, unit-tested) rejects a category-less broadcast with a form-level error instead of a domain round-trip, and matching errors surface as typed domain errors on the draft RFQ detail page instead of being uncaught. UI-created RFQs can now be sent and return supplier matches. **12 files changed:** 5 app surfaces (`rfq/page.tsx`, `rfq/forms.tsx`, `rfq/actions.ts`, `rfq/[rfqId]/page.tsx`, `products/[slug]/page.tsx`), the 2 new `src/lib` modules, and 5 test files. **Test additions:** `tests/unit/rfq-form.test.ts` (+235 lines, 18 unit tests) and `tests/e2e/rfq-ui-create.spec.ts` (+102 lines, 3 e2e tests); buyer-journey spec, e2e helpers, and the storefront integration spec adjusted. Merged 2026-09-21.

---

## 3. Architecture

### 3.1 Monorepo layout

```
packsource/
├── apps/web/                 # Next.js 15 (App Router), React 19, Tailwind v4
│   ├── src/app/              # storefront, rfq, orders, listings, admin, messaging, api routes
│   │   ├── api/auth/…        # Auth.js route handlers (magic link/callback)
│   │   ├── api/agent/…       # read-only org-scoped agent API (PR #15)
│   │   ├── api/dev/inbox/    # dev-only mock-mail inbox
│   │   └── …                 # wizard, search, product, compare, orders, payouts, admin
│   ├── src/auth.ts           # Auth.js v5 config (credentials + magic link)
│   ├── src/lib/              # adapters, db, magic-link, org-scoped, password, seo adapter
│   └── tests/                # unit (vitest), integration (vitest), e2e (playwright, §6)
├── packages/db/              # Prisma 6 client, schema, migrations, taxonomy, Zod validation, seed/importer CLIs
├── packages/core/            # domain logic: permissions, org-scoped repositories, escrow machine, onboarding, trust
├── packages/ai/              # typed adapters + deterministic mocks for 9 services
├── packages/search/          # Meilisearch facets, pgvector hybrid, outage fallback (PR #7)
├── packages/notifications/   # notification domain (PR #13)
├── packages/benchmarks/      # k-anonymous price benchmarks (PR #15)
├── packages/integrations/    # HMAC-signed Aekovera OS webhooks (PR #15)
├── packages/agent-api/       # read-only org-scoped agent API (PR #15)
├── packages/seo/             # metadata, JSON-LD, robots, sitemap (PR #15)
├── packages/ui/              # Tailwind v4 component kit + design tokens
├── .github/workflows/ci.yml  # three-job CI (§5a)
├── docker-compose.yml        # local pgvector Postgres 16
├── turbo.json                # build / dev / typecheck / test / test:integration
└── pnpm-workspace.yaml       # apps/* + packages/*, build-script allowlist
```

Dependency direction: `web` → `core` → `db`; `web` → `search` / `notifications` / `benchmarks` / `integrations` / `agent-api` / `seo` → `ai`/`db`; `ui` is leaf-level. `packages/db` owns all persistence and persistence-adjacent validation; `packages/core` owns domain rules that never touch SQL directly (it goes through the repositories it also defines, which use the Prisma client from `db`).

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
- **22 permissions** named `<domain>:<action>` — buyer-side (`catalog:search`, `workspace:manage`, `rfq:create`, `rfq:manage`, `cart:manage`, `order:create`, `order:approve`, `sample:order`), supplier-side (`supplier:onboard`, `profile:manage`, `listing:manage`, `quote:create`, `shipment:manage`), payments (`payout:view`, `payout:settle`), platform staff (`admin:access`, `supplier:verify`, `moderation:manage`, `dispute:mediate`, `placement:manage`), and shared (`analytics:view`, `message:send`). `payout:*` and `admin:access` were added by PR #13.
- Enforcement lives in `packages/core`: the role → permission matrix is central (call sites never branch on role strings), and every domain query flows through permission-gated repository functions that filter by the acting user's `orgId`. Postgres row-level security is a planned *hardening* step, not the primary gate.
- Supplier trust ladder (`VerificationStatus`): `UNVERIFIED` (importer default) → `VERIFIED` (documents, staff-verified in the admin console) → `AEKOVERA_VETTED` (site/reference check); status boosts search rank.

### 3.4 Architecture diagram

```mermaid
flowchart LR
    B["Buyer browser"] --> W
    S["Supplier browser"] --> W
    ST["Aekovera staff browser"] --> W
    AG["Aekovera OS agents"] -->|"read-only, org-scoped"| AA["/api/agent"]
    W["apps/web — Next.js 15 App Router<br/>server actions, Auth.js v5"]
    W --> CORE["packages/core<br/>permissions · org-scoped repositories<br/>escrow + order machines"]
    CORE --> DB["packages/db — Prisma 6<br/>PostgreSQL 16 + pgvector"]
    W --> SEO["packages/seo<br/>metadata · JSON-LD · robots · sitemap"]
    W --> SRCH["packages/search<br/>facets · hybrid · outage fallback"]
    W --> NOTIF["packages/notifications"]
    W --> BENCH["packages/benchmarks — k-anonymous"]
    W --> INT["packages/integrations<br/>HMAC Aekovera OS webhooks"]
    W --> AA
    CORE --> AI["packages/ai — createAdapters(env)<br/>10 adapters, deterministic mocks"]
    AI --> M["Claude · Gemini · Meilisearch · Stripe Connect<br/>Resend · Pusher · R2 · EasyPost · Inngest"]
```

---

## 4. Domain model (`packages/db/prisma/schema.prisma`)

**Scale:** 63 models, 38 enums, seven migrations (init + password hash + four trust migrations + admin notifications). Conventions stated in the schema header and enforced in code:

- **Org tenancy.** Every domain table carries `orgId`; queries go through permission-gated repository functions that filter by org (§3.3). The two platform-global exceptions (`Category`, k-anonymized `PriceBenchmark`) are documented on the models.
- **Money is integer cents everywhere** (`*Cents` fields: `minOrderValueCents`, `amountCents`, price tiers, payment and payout amounts, and so on); **rates are integer basis points** (`*Bps`). No floats touch money.
- **State is enum-typed** per the spec — 38 enums including `RfqMode`/`RfqStatus`, `QuoteStatus`, `NegotiationMessageKind`, `OrderStatus`/`SubOrderStatus`, `PaymentKind`/`PaymentStatus`, `RefundStatus`, `PayoutStatus` (`PENDING → PROCESSING → PAID | FAILED`), `EscrowEntryKind`, `InvoiceKind`/`InvoiceStatus`, `ShipmentStatus` (`CREATED → IN_TRANSIT | DELIVERED | EXCEPTION`), `DisputeStatus`/`DisputeOutcome`, `ReviewModerationStatus`, `VerificationStatus`, `ListingStatus`, `SpecExtractionStatus`, `ComplianceFramework`, `EmbeddingKind`, `WebhookDirection`/`WebhookDeliveryStatus`.
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

**Per-category Zod validation** (`packages/db/src/attribute-validation.ts`): validators are *derived from* the category attribute sets, so schema and validation can't drift. Validation is **strict — unknown keys are rejected** — listings cannot carry attributes outside their category's schema. A Zod meta-schema (`attributeSetSchema`, strict) validates the attribute-set documents themselves; violations raise `AttributeValidationError` with the full Zod issue list.

**Sustainability is dual-natured:** `sustainable-compostable` is a category *and* a cross-cutting flag — listings in any category may carry `RECYCLABLE` / `COMPOSTABLE` compliance claims (`Listing.complianceClaims`) while the dedicated category holds the assortment.

---

## 5. Workflows

### 5a. CI — `.github/workflows/ci.yml` (final state: PRs #2, #12, #16)

**Workflow name:** `CI`. **Triggers:** every `pull_request`, plus `push` to `main`. **Concurrency:** one run per `workflow + ref` group with `cancel-in-progress: true` (a new push cancels the superseded run). **Workflow-level env:** `MOCK: "true"` — CI always runs mock-first, zero API keys.

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

**Job 2 — `integration`** (`name: integration (pgvector service)`, `ubuntu-latest`): runs the integration suites against a **real pgvector Postgres** in a service container (`pgvector/pgvector:pg16`, db `packsource_test`, health `pg_isready` every 5s, 10 retries):

- Steps: checkout → pnpm → node → `pnpm install --frozen-lockfile` → **"Wait for Postgres readiness"** (PR #12 gate: 30 attempts × 2s, `psql SELECT 1`, explicit `::error` + `exit 1` on timeout) → **"Verify pgvector extension availability"** (`CREATE EXTENSION IF NOT EXISTS vector` then `pg_extension | grep vector`) → **"Integration suites"** (`pnpm test:integration`).

**Job 3 — `e2e`** (`name: e2e (Playwright, production build)`, `ubuntu-latest`, added by PR #16):

- **Service container:** `pgvector/pgvector:pg16`, db `packsource_e2e` (a dedicated database so the two Postgres jobs never share rows), same health options.
- **Job env:** `DATABASE_URL: postgresql://…@localhost:5432/packsource_e2e`, `E2E_PRODUCTION_SERVER: "1"` (switches the Playwright webServer from dev mode to `next start` against the built artifact).
- Steps: checkout → pnpm → node → `pnpm install --frozen-lockfile` → **readiness gate** (same pattern as PR #12) → **pgvector extension verification** → **`prisma migrate deploy`** → **deterministic seed** (recreated identically every run) → **production build** (`pnpm --filter @packsource/web build` — the artifact under test) → **`playwright install --with-deps chromium`** → **`pnpm --filter @packsource/web test:e2e`** → **failure artifacts** (`test-results/` + `playwright-report/` uploaded on `failure()`, 7-day retention).
- No job-level retry: `retries: 0` in the Playwright config, so CI failures are real failures, never masked.

### 5b. Product workflows (all merged and e2e-verified)

**Supplier onboarding (PR #4).** Six steps in wizard order: `company` → `plants` → `certifications` → `equipment` → `terms` → `payments`. Progress is **derived from what the wizard has already persisted**, not from a client-side pointer — a supplier who leaves and comes back resumes exactly where the data says they are (`firstIncomplete`). Nothing is publicly visible until the profile is submitted for review (`isPubliclyVisible`, `submittedForReviewAt`). Verified by `wizard.spec.ts` end to end, including reload-resume and the locked submitted panel.

**Discovery → RFQ → negotiation → order → escrow → payout (PRs #7, #8, #10, #11, #16).** The full trade loop, exercised by `buyer-journey.spec.ts`:

```mermaid
flowchart TD
    A["Buyer: faceted/semantic search (PR #7/#10)<br/>product page with landed-cost economics"] --> B["Buyer: RFQ sent<br/>(Rfq + RfqLines, OPEN)"]
    B --> C["Supplier sales: inbox → quote<br/>(SUBMITTED)"]
    C --> D["Supplier sales: counter-offer<br/>(revision — predecessor SUPERSEDED)"]
    D --> E["Buyer: award via accept-quote<br/>(Order + SubOrder per supplier leg, AWARDED)"]
    E --> F["Buyer: 30% deposit payment<br/>(ESCROW HOLD — mock Stripe charge, DEPOSIT_PAID)"]
    F --> G["Supplier ops: start + complete production<br/>(IN_PRODUCTION → READY_TO_SHIP)"]
    G --> H["Supplier ops: issue balance invoice;<br/>buyer pays 70% (BALANCE_DUE, balancePaid set)"]
    H --> I["Supplier ops: create shipment (MockCarrier/EasyPost)<br/>→ mark in transit (SHIPPED — gates on balancePaid)"]
    I --> J["Supplier ops: confirm delivery<br/>(DELIVERED → automatic ESCROW RELEASE — transfer)"]
    J --> K["Platform staff: settle payout<br/>(PENDING → PAID, net of commission)"]
```

**Trust flows (PR #14).** Buyer-supplier messaging threads with read state; verified-purchase reviews anchored to delivered order lines (ratings across quality/communication/on-time/packaging-accuracy), supplier responses, aggregate ratings, review moderation state; disputes open with evidence, discussion, buyer withdrawal, staff mediation to refund/payout outcomes; fraud controls and rate limiting.

**Admin & notifications (PR #13).** Staff console over verification (trust ladder), moderation (listings/reviews), dispute mediation, featured placements, org access, audit log with CSV export; the notification domain surfaces in-app notifications across these workflows.

**AI & integrations (PR #15).** Deterministic listing extraction behind human confirmation (PR #9); k-anonymous price benchmarks; HMAC-signed webhook deliveries to Aekovera OS; read-only org-scoped agent API (`/api/agent`); SEO metadata, Product/Organization JSON-LD, robots, and sitemap.

---

## 6. Test matrix

Actual file counts on `main` at `eabbc5b` (verified by listing the trees and running the web unit suite this session; unit = `tests/unit/*.test.ts`, integration = `tests/integration/*.test.ts` per workspace):

| Workspace | Unit files | Integration files |
|---|---|---|
| `apps/web` | 5 | 3 |
| `packages/ai` | 4 | 0 |
| `packages/core` | 10 | 9 |
| `packages/db` | 3 | 3 |
| `packages/ui` | 2 | 0 |
| `packages/search` | 4 | 1 |
| `packages/notifications` | 1 | 1 |
| `packages/benchmarks` | 1 | 0 |
| `packages/integrations` | 1 | 1 |
| **Totals** | **31** | **18** |

**E2E — Playwright 1.63.0 (`apps/web/tests/e2e/`; closing suite from PR #16, extended by PR #17):**

| Spec | Tests | Coverage |
|---|---|---|
| `auth.spec.ts` | 4 | Password sign-in; mock-inbox magic link (self-skips under `E2E_PRODUCTION_SERVER=1` — the dev-inbox route is dev-only by design); unauthenticated visits to protected surfaces redirect to sign-in; wrong password rejected without a session |
| `wizard.spec.ts` | 1 | Six-step onboarding through the real UI and server actions, reload-resume mid-wizard, submission, locked submitted panel |
| `buyer-journey.spec.ts` | 1 | The full §5b trade loop: bootstrapped RFQ → sent-RFQ dashboard/detail → supplier quote → counter-offer negotiation → buyer award → order confirmation → deposit payment → production → balance invoice + payment → shipment creation → transit → delivery → automatic escrow release → staff payout settlement → terminal `ESCROW_RELEASED`/`PAID` state visible to buyer and supplier |
| `supplier-listing.spec.ts` | 1 | Draft creation, deterministic spec-sheet upload → AI extraction, suggestion confirmation, submit for review (`DRAFT → PENDING_REVIEW`) |
| `storefront-compare.spec.ts` | 2 | Seeded search narrowing + product-page economics; compare tray → `/compare` table with both products |
| `rfq-ui-create.spec.ts` | 3 | RFQ creation through the real UI (PR #17): broadcast with a category sends and returns supplier matches; a product-page deep link creates a SINGLE-listing RFQ with the inherited category; broadcast without a category is rejected as form copy, not a domain error |
| **Total** | **12 tests, 6 specs** | 11 run in CI (magic-link self-skips in production mode); single worker, `retries: 0` |

**Determinism mechanics (the suite is re-runnable against a reused database):**
- `global-setup.ts` runs `prisma migrate reset --force` + the deterministic seed on every invocation, so local runs start from exactly the state CI provisions (the mock Stripe adapter mints deterministic payment-intent ids; without the reset, rows from previous runs collide on unique constraints).
- Global setup provisions idempotent e2e accounts (buyer `OWNER`, supplier `SUPPLIER_SALES`, supplier `SUPPLIER_OPS`, platform `AEKOVERA_STAFF`, wizard supplier) against the seeded orgs with scrypt-hashed passwords matching `apps/web`'s verifier.
- The RFQ and listing specs create fresh, uniquely suffixed records per run; the wizard test resets its own organization's onboarding rows first.
- `test.slow()` applies to the buyer journey (three authenticated contexts, full payment/fulfillment lifecycle); expectation timeout 20s; zero retries — a failure is a failure.
- CI runs the suite against the **production build** via `next start` (`E2E_PRODUCTION_SERVER=1`); locally the webServer boots dev mode by default and the same suite passes in both modes.

**Seeded fixture counts** (from the deterministic seed, verified in CI logs): categories 21 · supplier orgs 150 · buyer orgs 40 · users 40 · supplier profiles 150 · plants 188 · capabilities 500 · listings 1,500 · MOQ tiers 4,200 · lead-time rules 2,100 · orders 60 · sub-orders 60 · order lines 120 · reviews 30.

---

## 7. Running locally — zero API keys

`MOCK=true` is the default everywhere; **no API keys are needed to boot, test, demo, or run the e2e suite.** (`MOCK=false` intentionally raises `MockModeError` until real provider adapters are wired.)

```bash
# 0. Prereqs: Node >= 20, pnpm 10.34.5 (root package.json "packageManager")
corepack enable                       # or: npm install -g pnpm@10.34.5

# 1. Install (packages/db postinstall runs `prisma generate`)
pnpm install

# 2. Postgres 16 + pgvector (container: packsource-db, user/pass packsource, db packsource)
docker compose up -d db               # healthcheck: pg_isready -U packsource -d packsource

# 3. Point DATABASE_URL at it (only DATABASE_URL is needed)
export DATABASE_URL=postgresql://packsource:packsource@localhost:5432/packsource

# 4. Apply all committed migrations and seed
pnpm --filter @packsource/db exec prisma migrate deploy
pnpm --filter @packsource/db seed     # idempotent; recreates seed_* rows identically

# 5. Run
pnpm dev                # turbo run dev → web at http://localhost:3000 (health at /health)
pnpm lint               # eslint .
pnpm typecheck          # turbo run typecheck
pnpm test               # unit suites (DB-independent)
pnpm test:integration   # integration suites against the pgvector Postgres
pnpm build              # turbo run build
```

**E2E suite (apps/web):**

```bash
# Dedicated database strongly recommended (the suite resets it — see §6)
export DATABASE_URL=postgresql://packsource:packsource@localhost:5432/packsource_e2e
export AUTH_SECRET=e2e-test-secret-not-for-production
export MOCK=true

pnpm --filter @packsource/web test:e2e                 # full suite (12 tests; 11 run in CI — see §6)
pnpm --filter @packsource/web exec playwright test tests/e2e/buyer-journey.spec.ts   # one spec
pnpm --filter @packsource/web exec playwright show-report
```

- The Playwright webServer boots dev mode by default; set `E2E_PRODUCTION_SERVER=1` to test `next start` against a production build (what CI does).
- Global setup resets + reseeds the database every run, provisions the e2e accounts, and is safe to re-run — the suite never depends on prior run state.
- Failure traces, screenshots, and the error-context are retained under `apps/web/test-results/`.

| Command (root `package.json`) | Script |
|---|---|
| `pnpm lint` | `eslint .` |
| `pnpm typecheck` | `turbo run typecheck` |
| `pnpm test` | `turbo run test` |
| `pnpm test:integration` | `turbo run test:integration` |
| `pnpm format` / `format:check` | `prettier --write .` / `prettier --check .` |

Dev-mail: outbound email goes to the mock Mail adapter; read it at `/api/dev/inbox` in the web app (dev server only — which is why the magic-link e2e self-skips against production builds).

---

## 8. Closing state

**All spec waves are merged.** The build closed with PR #16 (this document, the e2e suite, and the e2e CI job), followed by the post-close RFQ-creation fix (PR #17). Post-v1.0 items, tracked outside this build:

1. **✅ RESOLVED by PR #17 (`eabbc5b3c1e598a851a8711548385a3ff57b768f`, merged 2026-09-21):** the RFQ-creation defect PR #16 first reported — the UI RFQ-creation form offered no category selector or single-listing mode while RFQ broadcast matching requires a `categoryId`, so UI-created RFQs could not be sent, and the draft RFQ detail page could surface an uncaught domain error in the matching path. PR #17 added category selection and a SINGLE-listing mode to the form (product-page deep links inherit the listing's category), surfaced typed matching errors on the draft detail page, and covered it with the `rfq-ui-create.spec.ts` e2e spec; UI-created RFQs now send and return supplier matches.
2. **Postgres row-level security** — hardening layer on top of the repository-level org gates (explicitly a hardening step, not the primary gate, per `permissions.ts`).
3. **Real provider adapters** — implement the same ten interfaces behind `MOCK=false` env switching at deploy time (the seam is already the contract).

---

*Prepared from the repository state at `eabbc5b` (`main`), and the GitHub PR API on 2026-09-21. Sources: `git log origin/main`, `gh pr view` for #2–#17 (merge SHAs and changed-file counts), `.github/workflows/ci.yml`, `packages/core/src/permissions.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/seed/seed.ts` (seed counts cross-checked against CI seed logs), `apps/web/tests/e2e/*` (specs, helpers, global-setup), `apps/web/playwright.config.ts`, and the test trees listed in §6.*
