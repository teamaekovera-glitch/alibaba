# PackSource

Aekovera's vertical B2B marketplace for food & beverage packaging: emerging CPG brands discover verified packaging suppliers, compare structured products and landed costs, run RFQs, negotiate terms, and buy with escrow-protected payments. Built in `teamaekovera-glitch/alibaba` per the approved spec (Blueprint artifact `art_tooqnEmJ`).

📄 **Architecture, PR index, test matrix, and the full runbook live in [docs/IMPLEMENTATION-SUMMARY.md](docs/IMPLEMENTATION-SUMMARY.md).**

## What's in the box

- **Discovery** — faceted Meilisearch search, pgvector semantic/hybrid ranking, visual search, and a Postgres-outage fallback; product pages with full landed-cost economics; four-item compare.
- **Trade** — RFQs, supplier quotes, negotiation threads, quote cart, awards, and the 30/70 order machine (deposit → production → balance → shipment → delivery) with Stripe Connect mock escrow, automatic release, and staff payout settlement.
- **Supplier side** — six-step resumable onboarding, listing editors with bulk CSV import, human-reviewed AI spec extraction, quote response, fulfillment.
- **Trust** — messaging, verified-purchase reviews with responses and aggregates, dispute lifecycle with mediation, fraud controls.
- **Operations** — staff admin console (verification, moderation, disputes, placements, audit/export), notifications, k-anonymous price benchmarks, HMAC-signed Aekovera OS webhooks, a read-only org-scoped agent API, and SEO metadata/JSON-LD/robots/sitemap.

## Stack

- pnpm 10.34.5 + Turborepo workspaces, Node 20+, TypeScript strict
- `apps/web` — Next.js 15 (App Router), React 19, Tailwind v4, Auth.js v5
- `packages/db` — Prisma 6, Postgres 16 + pgvector (63 models, 38 enums, taxonomy, strict attribute validation, importer, deterministic seed)
- `packages/core` — permissions (7 roles × 22 permissions), org-scoped repositories, order/escrow machines, onboarding, trust
- `packages/ai` — typed adapters for nine external services (Claude, Gemini, Meilisearch, Stripe Connect, Resend, Pusher, R2, EasyPost, Inngest), each with a deterministic mock
- `packages/search` · `packages/notifications` · `packages/benchmarks` · `packages/integrations` · `packages/agent-api` · `packages/seo` — search, trust, and integration surfaces
- `packages/ui` — Tailwind v4 component kit + design tokens

## Mock-first — zero API keys

`MOCK=true` is the default and routes every external service to a deterministic in-memory mock (no `Math.random`, no `Date.now`, no network). The platform boots, tests, demos, and runs its entire e2e suite with zero keys; real credentials attach at deploy time through the same interfaces (`MOCK=false` raises `MockModeError` until they are wired).

## Setup

```bash
corepack enable             # or: npm install -g pnpm@10.34.5
pnpm install
docker compose up -d db     # Postgres 16 + pgvector (user/pass packsource)

export DATABASE_URL=postgresql://packsource:packsource@localhost:5432/packsource
pnpm --filter @packsource/db exec prisma migrate deploy
pnpm --filter @packsource/db seed   # deterministic fictional data, idempotent

pnpm dev                    # http://localhost:3000 — health check at /health
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev servers via Turborepo |
| `pnpm build` | Build all workspaces |
| `pnpm lint` | ESLint (flat config) across the monorepo |
| `pnpm typecheck` | TypeScript strict per workspace |
| `pnpm test` | Vitest unit suites (DB-independent) |
| `pnpm test:integration` | Vitest integration suites (pgvector Postgres) |
| `pnpm format` / `format:check` | Prettier |
| `pnpm --filter @packsource/web test:e2e` | Playwright end-to-end suite (see below) |

## End-to-end tests

Nine Playwright tests (`apps/web/tests/e2e/`) cover password + magic-link auth, protected routes, the six-step onboarding wizard with resume, supplier listing create → AI extraction → submit, storefront search + compare, and the complete buyer journey — RFQ → quote → counter-offer → award → deposit → production → balance invoice → shipment → delivery → automatic escrow release → staff payout settlement. Global setup resets and reseeds the database and provisions deterministic e2e accounts on every run.

```bash
export DATABASE_URL=postgresql://packsource:packsource@localhost:5432/packsource_e2e
export AUTH_SECRET=e2e-test-secret-not-for-production
export MOCK=true
pnpm --filter @packsource/web test:e2e
```

Details: [docs/IMPLEMENTATION-SUMMARY.md](docs/IMPLEMENTATION-SUMMARY.md) (test matrix, determinism mechanics, CI wiring).

## CI

GitHub Actions runs on every PR and push to `main` (`MOCK=true` throughout, zero API keys):

- **verify** — lint, typecheck, unit tests, build.
- **integration** — real `pgvector/pgvector:pg16` service container with a bounded readiness gate (30 × 2s, explicit failure on timeout), extension verification, then the integration suites.
- **e2e** — dedicated pgvector service (`packsource_e2e`), readiness gate, `prisma migrate deploy`, deterministic seed, **production build**, Chromium install, Playwright run (`next start`, `retries: 0`), and failure-artifact upload.
