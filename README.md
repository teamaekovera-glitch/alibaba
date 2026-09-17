# PackSource

Aekovera's CPG packaging marketplace: discover packaging suppliers, run RFQs, negotiate, and buy with escrow-protected payments. Greenfield monorepo in `teamaekovera-glitch/alibaba` — architecture, domain model, and locked decisions live in the approved spec (Blueprint artifact `art_tooqnEmJ`).

📄 **A detailed implementation summary — PR index, architecture, CI workflows, test matrix, and local runbook — lives in [docs/IMPLEMENTATION-SUMMARY.md](docs/IMPLEMENTATION-SUMMARY.md).**

## Stack

- pnpm 10.34.5 + Turborepo workspaces, Node 20+, TypeScript strict
- `apps/web` — Next.js 15 (App Router)
- `packages/db` — Prisma 6, Postgres 16 + pgvector (docker-compose locally, Neon in prod)
- `packages/core` — domain logic (pricing & landed cost, escrow state machine, permissions)
- `packages/ai` — typed adapters for the nine external services, each with a deterministic mock
- `packages/ui` — Tailwind v4 component kit + design tokens

## Mock-first — zero API keys

`MOCK=true` is the default and routes every external service — Claude, Gemini, Meilisearch, Stripe Connect, Resend, Pusher, R2, EasyPost, Inngest — to a deterministic in-memory mock. The platform boots, tests, and demos with zero keys; real credentials are configured at deploy time and switch adapters via env vars without code changes.

## Setup

```bash
corepack enable            # or: npm install -g pnpm@10.34.5
pnpm install
docker compose up -d db    # Postgres 16 + pgvector
cp .env.example .env
pnpm dev                   # http://localhost:3000 — health check at /health
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev servers via Turborepo |
| `pnpm build` | Build all workspaces |
| `pnpm lint` | ESLint (flat config) across the monorepo |
| `pnpm typecheck` | TypeScript strict per workspace |
| `pnpm test` | Vitest unit suites (DB-independent) |
| `pnpm test:integration` | Vitest integration suites (pgvector service) |
| `pnpm format` | Prettier |

## CI

GitHub Actions runs on every PR:

- **verify** — lint, typecheck, unit tests, build; a `pgvector/pgvector:pg16` service container is available.
- **integration** — same Postgres service, wired for integration suites that later workstreams add; currently asserts the `vector` extension is available in the service database.
