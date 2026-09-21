# @packsource/agent-api

Agent-readable, read-only JSON surface over the public catalog (spec: agent
surface). Deterministic, mock-first, zero API keys.

## Authentication

`Authorization: Bearer <key>` where `<key>` is the org's deterministic mock
key (`agentKeyForOrg(orgId)` → `pak_<orgId>_<8-hex-check>`). Keys verify
statelessly; the bearer org scopes rate limiting. Mock-only by design —
production would store hashed keys with rotation. Missing or invalid keys
get a stable `401` error body.

## Rate limiting (stub)

Fixed window per bearer org: **60 requests / minute** (`AGENT_RATE_LIMIT`),
in-process memory, deterministic clock injection. Exceeding it returns `429`
with `Retry-After`. The `RateLimitEvent` table exists for durable recording;
the stub stays pure so tests need no database.

## Endpoints (apps/web)

| Route | Purpose |
| --- | --- |
| `GET /api/agent/listings` | Paged LIVE listings (`limit`, `offset`) |
| `GET /api/agent/suppliers` | Paged supplier orgs with profiles (`limit`, `offset`, optional `slug`) |
| `GET /api/agent/search` | Discovery via the public search contract (`parseListingQuery` params), keyword or hybrid, per-hit engine scores |

List endpoints return `{ data, paging: { limit, offset, total } }`.

## Shapes (stability contract)

Serialized by `packages/agent-api/src/serialize.ts` — the single source of
truth. Field order is fixed by construction; additive changes only.

### AgentListing

```
{ id, slug, url: "/products/<slug>", title, description,
  category: { family, leaf }, material, sizeBand,
  moq: { qty, band }, price: { fromCents, band },
  leadTimeDays, locations: { cities[], countries[] },
  certifications[], sustainability[], supplier: { id, name, slug } }
```

Money is integer cents (`fromCents`). Listing data is projected from the
search document — the same public projection the storefront renders — so the
agent surface cannot drift ahead of what is published.

### AgentSupplier

```
{ id, name, slug, about, verificationStatus, responseTimeHours,
  minOrderValueCents, paymentTerms,
  locations: [{ city, country, isPrimary }] }
```

Orgs without a completed supplier profile are excluded; verification status
is exposed as data for agent-side filtering.

### AgentSearchHit

```
{ score, listing: AgentListing }
```

`score` is the engine's relevance (keyword relevance with tier boosts, or
hybrid blended score). The response adds `mode` (`keyword` | `hybrid`),
`total`, and `source` (search backend that answered).
