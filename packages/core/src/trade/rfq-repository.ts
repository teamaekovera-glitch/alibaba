/**
 * RFQ engine — buyer-side repository (spec: "RFQ → quote → order").
 *
 * Tenancy model: unlike the strictly org-scoped repositories, trade reads
 * are *participation-scoped* — an RFQ is readable by its buyer org and by
 * supplier orgs holding a quote-request thread on it. Writes stay with the
 * buyer org and are permission-gated (`rfq:create` to create, `rfq:manage`
 * to send/close/cancel).
 *
 * Supplier matching is deliberately SQL-first (spec: "support supplier
 * matching via taxonomy and attribute overlap… use SQL filters") — NOT the
 * search index: coarse jsonb attribute-containment filters plus MOQ-tier
 * support in Postgres, exact overlap scoring in a pure function here.
 *
 * Each supplier target gets a Thread (kind RFQ) — the quote request and the
 * negotiation chat channel in one row.
 */
import { Prisma, type PrismaClient, type QuoteStatus, type RfqMode } from "@packsource/db";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";
import { parseRfqSpec, type RfqSpec } from "./rfq-spec";
import {
  assertCloseTimeAllows,
  rfqTransition,
} from "./rfq-machine";

/** Audit-log actions written by the RFQ engine (append-only). */
export const RFQ_AUDIT = {
  create: "rfq.create",
  send: "rfq.send",
  close: "rfq.close",
  cancel: "rfq.cancel",
} as const;

/** One line of the buyer's RFQ (what they want quoted). */
export interface RfqLineInput {
  /** Optional reference listing ("quote this, or equivalent"). */
  listingId?: string | null;
  description: string;
  quantity: number;
  unit?: string | null;
  /** Structured attributes for this line; validated against the RFQ category. */
  targetAttributes?: Record<string, unknown>;
}

export interface CreateRfqInput {
  mode: RfqMode;
  title: string;
  description?: string | null;
  /** Taxonomy category — required for BROADCAST/AUCTION (matching scope). */
  categoryId?: string | null;
  /** SINGLE-mode target listing; its org is the sole invitee. */
  listingId?: string | null;
  /** Head target quantity (headline of the request). */
  quantity?: number | null;
  /** Structured spec: attributes + destination + need-by (see rfq-spec). */
  spec?: RfqSpec | Record<string, unknown> | null;
  /** AUCTION close time (required, must be in the future). */
  closesAt?: Date | null;
  lines: RfqLineInput[];
}

/** Raised when an RFQ fails structural validation. */
export class InvalidRfqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRfqError";
  }
}

/** Raised when a broadcast/auction RFQ would go to zero suppliers. */
export class EmptyBroadcastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyBroadcastError";
  }
}

/** A supplier-org match for an RFQ: best listing + attribute overlap. */
export interface SupplierMatch {
  orgId: string;
  listingId: string;
  listingTitle: string;
  /** Number of spec attributes the listing satisfies. */
  score: number;
  /** Spec attribute keys the listing satisfies (stable order). */
  matchedAttributes: string[];
  /** Cheapest tier at or below the RFQ quantity. */
  unitPriceCents: number | null;
}

/** Postgres candidates for matching: one live listing per row. */
interface ListingCandidateRow {
  listingId: string;
  orgId: string;
  listingTitle: string;
  attributes: unknown;
}

/**
 * Pure attribute-overlap scorer: count spec keys the listing satisfies.
 * Scalars and booleans match on equality; arrays (multiEnum) match on any
 * intersection. Deterministic — no wall-clock, no randomness.
 */
export function attributeOverlap(
  specAttributes: Record<string, unknown>,
  listingAttributes: Record<string, unknown>,
): { score: number; matched: string[] } {
  const matched: string[] = [];
  for (const [key, want] of Object.entries(specAttributes)) {
    const have = listingAttributes[key];
    if (have === undefined) {
      continue;
    }
    if (Array.isArray(want) && Array.isArray(have)) {
      if (want.some((w) => have.includes(w))) {
        matched.push(key);
      }
    } else if (want === have) {
      matched.push(key);
    }
  }
  return { score: matched.length, matched };
}

/** Stable ordering: score desc, then listingId asc (deterministic). */
function byMatchStrength(a: SupplierMatch, b: SupplierMatch): number {
  return b.score - a.score || a.listingId.localeCompare(b.listingId);
}

export class RfqRepository {
  readonly #db: PrismaClient;
  readonly #auth: AuthContext;

  constructor(db: PrismaClient, auth: AuthContext) {
    this.#db = db;
    this.#auth = auth;
  }

  #require(permission: Permission): void {
    assertCan(this.#auth.role, permission);
  }

  async #audit(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId: this.#auth.orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType,
        entityId,
      },
    });
  }

  // ── create ────────────────────────────────────────────────────────────────

  /** Create a DRAFT RFQ with its lines. Nothing is sent to suppliers yet. */
  async create(input: CreateRfqInput) {
    this.#require("rfq:create");
    if (input.lines.length === 0) {
      throw new InvalidRfqError("an RFQ needs at least one line");
    }
    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new InvalidRfqError(`line quantity must be a positive integer, got ${line.quantity}`);
      }
      if (line.description.trim().length === 0) {
        throw new InvalidRfqError("line description is required");
      }
    }
    if (input.title.trim().length === 0) {
      throw new InvalidRfqError("title is required");
    }

    // SINGLE RFQs are invite-specific: the listing pins the category and the
    // sole invitee. BROADCAST/AUCTION RFQs need a category to match against.
    let categoryId = input.categoryId ?? null;
    if (input.mode === "SINGLE") {
      if (!input.listingId) {
        throw new InvalidRfqError("SINGLE RFQs require a listingId");
      }
      const listing = await this.#db.listing.findFirst({
        where: { id: input.listingId, status: "LIVE" },
      });
      if (!listing) {
        throw new RecordNotFoundError("Listing", input.listingId);
      }
      if (listing.orgId === this.#auth.orgId) {
        throw new InvalidRfqError("cannot request a quote from your own organization");
      }
      categoryId = listing.categoryId;
    } else if (!categoryId) {
      throw new InvalidRfqError(`${input.mode} RFQs require a categoryId`);
    }

    const category = categoryId
      ? await this.#db.category.findFirst({ where: { id: categoryId } })
      : null;
    if (categoryId && !category) {
      throw new RecordNotFoundError("Category", categoryId);
    }

    if (input.mode === "AUCTION") {
      if (!input.closesAt) {
        throw new InvalidRfqError("AUCTION RFQs require a close time");
      }
      if (input.closesAt.getTime() <= Date.now()) {
        throw new InvalidRfqError("auction close time must be in the future");
      }
    }

    const spec = parseRfqSpec(input.spec ?? {}, { categorySlug: category?.slug ?? null });

    return this.#db.$transaction(async (tx) => {
      const rfq = await tx.rfq.create({
        data: {
          orgId: this.#auth.orgId,
          buyerUserId: this.#auth.userId,
          mode: input.mode,
          title: input.title,
          description: input.description ?? null,
          categoryId,
          listingId: input.listingId ?? null,
          quantity: input.quantity ?? null,
          spec: spec as Prisma.InputJsonValue,
          status: "DRAFT",
          closesAt: input.mode === "AUCTION" ? (input.closesAt ?? null) : null,
          lines: {
            create: input.lines.map((line) => ({
              orgId: this.#auth.orgId,
              listingId: line.listingId ?? null,
              description: line.description,
              quantity: line.quantity,
              unit: line.unit ?? null,
              targetAttributes: (line.targetAttributes ?? {}) as Prisma.InputJsonValue,
            })),
          },
        },
      });
      await this.#audit(tx, RFQ_AUDIT.create, "Rfq", rfq.id);
      return rfq;
    });
  }

  // ── send ──────────────────────────────────────────────────────────────────

  /**
   * Send a DRAFT RFQ: OPEN it and create one quote-request thread per target
   * supplier. Targets: SINGLE → the listing's org; explicit inviteOrgIds →
   * exactly those supplier orgs; otherwise → matched suppliers (broadcast).
   */
  async send(rfqId: string, input: { inviteOrgIds?: string[]; at?: Date } = {}) {
    this.#require("rfq:manage");
    const at = input.at ?? new Date();
    return this.#db.$transaction(async (tx) => {
      const rfq = await tx.rfq.findFirst({
        where: { id: rfqId, orgId: this.#auth.orgId },
      });
      if (!rfq) {
        throw new RecordNotFoundError("Rfq", rfqId);
      }
      const next = rfqTransition(rfq.status, { type: "SEND", at });

      const targets =
        rfq.mode === "SINGLE"
          ? await this.#singleTargets(tx, rfq)
          : input.inviteOrgIds && input.inviteOrgIds.length > 0
            ? await this.#resolveInvites(tx, input.inviteOrgIds)
            : (await this.matchSuppliers(rfq.id)).map((m) => m.orgId);
      if (targets.length === 0) {
        throw new EmptyBroadcastError(
          "no suppliers to send to — no live listings matched this RFQ's category, MOQ, and attributes",
        );
      }

      const updated = await tx.rfq.update({
        where: { id: rfq.id },
        data: { status: next, sentAt: at },
      });
      const threads = await Promise.all(
        targets.map((supplierOrgId) =>
          tx.thread.create({
            data: {
              kind: "RFQ",
              buyerOrgId: this.#auth.orgId,
              supplierOrgId,
              rfqId: rfq.id,
              subject: rfq.title,
            },
          }),
        ),
      );
      await this.#audit(tx, RFQ_AUDIT.send, "Rfq", rfq.id);
      return { rfq: updated, threads };
    });
  }

  /** SINGLE target: the listing's org (re-checked live, not trusted from input). */
  async #singleTargets(tx: Prisma.TransactionClient, rfq: { listingId: string | null }): Promise<string[]> {
    if (!rfq.listingId) {
      throw new InvalidRfqError("SINGLE RFQ has no target listing");
    }
    const listing = await tx.listing.findFirst({
      where: { id: rfq.listingId, status: "LIVE" },
    });
    if (!listing || listing.orgId === this.#auth.orgId) {
      throw new InvalidRfqError("RFQ's target listing is no longer live");
    }
    return [listing.orgId];
  }

  /** Explicit invite list: must be existing supplier orgs. */
  async #resolveInvites(tx: Prisma.TransactionClient, inviteOrgIds: string[]): Promise<string[]> {
    const orgs = await tx.organization.findMany({
      where: { id: { in: inviteOrgIds }, type: "SUPPLIER", deletedAt: null },
    });
    if (orgs.length !== new Set(inviteOrgIds).size) {
      throw new InvalidRfqError("one or more invited organizations are not supplier orgs");
    }
    return orgs.map((o) => o.id).sort();
  }

  // ── supplier matching (SQL coarse filter + pure overlap scoring) ─────────

  /**
   * Match supplier orgs for an RFQ. SQL prefilter: live listings in the
   * RFQ's category that support the RFQ quantity (a MOQ tier at or below it)
   * and contain every scalar spec attribute (jsonb @>). Overlap scoring
   * happens in TS so arrays (multiEnum any-intersect) rank correctly.
   * Returns one match per supplier org — its best listing.
   */
  async matchSuppliers(rfqId: string): Promise<SupplierMatch[]> {
    const rfq = await this.#db.rfq.findFirst({
      where: {
        id: rfqId,
        OR: [{ orgId: this.#auth.orgId }, { threads: { some: { supplierOrgId: this.#auth.orgId } } }],
      },
      include: { category: true, lines: { select: { quantity: true } } },
    });
    if (!rfq) {
      throw new RecordNotFoundError("Rfq", rfqId);
    }
    if (!rfq.categoryId) {
      throw new InvalidRfqError("RFQ has no category to match against");
    }
    const category = rfq.category;
    if (!category) {
      throw new RecordNotFoundError("Category", rfq.categoryId);
    }
    const spec = parseRfqSpec(rfq.spec, { categorySlug: category.slug });
    const specAttributes = spec.attributes ?? {};
    const quantity = rfq.quantity ?? rfq.lines.reduce((min, line) => Math.min(min, line.quantity), Number.MAX_SAFE_INTEGER);

    // Coarse SQL filter — taxonomy category + MOQ support + scalar containment.
    const conditions: Prisma.Sql[] = [
      Prisma.sql`l."categoryId" = ${rfq.categoryId}`,
      Prisma.sql`l."status" = 'LIVE'`,
      Prisma.sql`EXISTS (SELECT 1 FROM "MoqPriceTier" t WHERE t."listingId" = l."id" AND t."minQty" <= ${quantity})`,
    ];
    for (const [key, value] of Object.entries(specAttributes)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        conditions.push(Prisma.sql`l."attributes" @> ${JSON.stringify({ [key]: value })}::jsonb`);
      }
    }
    const rows = await this.#db.$queryRaw<ListingCandidateRow[]>(
      Prisma.sql`
        SELECT l."id" AS "listingId", l."orgId" AS "orgId", l."title" AS "listingTitle", l."attributes" AS "attributes"
        FROM "Listing" l
        WHERE ${Prisma.join(conditions, " AND ")}
        ORDER BY l."id" ASC
      `,
    );

    // One best match per supplier org, scored on full attribute overlap.
    const bestPerOrg = new Map<string, SupplierMatch>();
    const tierPrices = await this.#bestTierPrices(rows.map((r) => r.listingId), quantity);
    for (const row of rows) {
      if (row.orgId === this.#auth.orgId) {
        continue; // never match the buyer's own org
      }
      const listingAttributes = (row.attributes ?? {}) as Record<string, unknown>;
      const { score, matched } = attributeOverlap(specAttributes, listingAttributes);
      const match: SupplierMatch = {
        orgId: row.orgId,
        listingId: row.listingId,
        listingTitle: row.listingTitle,
        score,
        matchedAttributes: matched,
        unitPriceCents: tierPrices.get(row.listingId) ?? null,
      };
      const incumbent = bestPerOrg.get(row.orgId);
      if (!incumbent || byMatchStrength(match, incumbent) < 0) {
        bestPerOrg.set(row.orgId, match);
      }
    }
    return [...bestPerOrg.values()].sort(byMatchStrength);
  }

  /** Cheapest tier at or below `quantity` per listing, in one query. */
  async #bestTierPrices(listingIds: string[], quantity: number): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (listingIds.length === 0) {
      return prices;
    }
    const tiers = await this.#db.moqPriceTier.findMany({
      where: { listingId: { in: listingIds }, minQty: { lte: quantity } },
      orderBy: [{ listingId: "asc" }, { unitPriceCents: "asc" }],
    });
    for (const tier of tiers) {
      if (!prices.has(tier.listingId)) {
        prices.set(tier.listingId, tier.unitPriceCents);
      }
    }
    return prices;
  }

  // ── close / cancel ────────────────────────────────────────────────────────

  /** Stop accepting quotes. Auctions cannot close before their close time. */
  async close(rfqId: string, at: Date = new Date()) {
    this.#require("rfq:manage");
    return this.#db.$transaction(async (tx) => {
      const rfq = await this.#ownedRfq(tx, rfqId);
      assertCloseTimeAllows(rfq, "CLOSE", at);
      const next = rfqTransition(rfq.status, { type: "CLOSE", at });
      const updated = await tx.rfq.update({ where: { id: rfq.id }, data: { status: next } });
      await this.#audit(tx, RFQ_AUDIT.close, "Rfq", rfq.id);
      return updated;
    });
  }

  /** Cancel before award. Auctions already past their close time must CLOSE instead. */
  async cancel(rfqId: string, at: Date = new Date()) {
    this.#require("rfq:manage");
    return this.#db.$transaction(async (tx) => {
      const rfq = await this.#ownedRfq(tx, rfqId);
      assertCloseTimeAllows(rfq, "CANCEL", at);
      const next = rfqTransition(rfq.status, { type: "CANCEL", at });
      const updated = await tx.rfq.update({ where: { id: rfq.id }, data: { status: next } });
      await this.#audit(tx, RFQ_AUDIT.cancel, "Rfq", rfq.id);
      return updated;
    });
  }

  // ── reads (participation-scoped) ──────────────────────────────────────────

  /**
   * The RFQ when the acting org is the buyer or an invited supplier.
   * Suppliers see the RFQ and only their own thread — never the competitor
   * quote list; the buyer sees quote counts.
   */
  async rfqForActor(rfqId: string) {
    const base = await this.#db.rfq.findFirst({
      where: {
        id: rfqId,
        OR: [
          { orgId: this.#auth.orgId },
          { threads: { some: { supplierOrgId: this.#auth.orgId } } },
        ],
      },
      select: { orgId: true },
    });
    if (!base) {
      throw new RecordNotFoundError("Rfq", rfqId);
    }
    const isBuyer = base.orgId === this.#auth.orgId;
    const rfq = await this.#db.rfq.findFirst({
      where: { id: rfqId },
      include: {
        lines: true,
        category: true,
        ...(isBuyer
          ? {
              quotes: {
                where: { status: { in: ["SUBMITTED", "ACCEPTED"] satisfies QuoteStatus[] } },
                select: { id: true },
              },
            }
          : {}),
      },
    });
    if (!rfq) {
      throw new RecordNotFoundError("Rfq", rfqId);
    }
    return rfq;
  }

  /** The buyer org's RFQ dashboard (newest first). */
  async listMine() {
    return this.#db.rfq.findMany({
      where: { orgId: this.#auth.orgId },
      orderBy: { createdAt: "desc" },
      include: { category: true, _count: { select: { quotes: true, threads: true } } },
    });
  }

  /** Supplier inbox: RFQ threads addressed to this supplier org. */
  async inbox() {
    return this.#db.thread.findMany({
      where: { supplierOrgId: this.#auth.orgId, kind: "RFQ" },
      orderBy: { lastMessageAt: "desc" },
      include: { rfq: { include: { lines: true, category: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
  }

  /** Buyer view of all quote-request threads on an owned RFQ. */
  async threadsForRfq(rfqId: string) {
    const rfq = await this.#db.rfq.findFirst({
      where: { id: rfqId, orgId: this.#auth.orgId },
    });
    if (!rfq) {
      throw new RecordNotFoundError("Rfq", rfqId);
    }
    return this.#db.thread.findMany({
      where: { rfqId, buyerOrgId: this.#auth.orgId, kind: "RFQ" },
      orderBy: { createdAt: "asc" },
      include: { supplierOrg: true },
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Load an owned RFQ with the timing fields the guards need. */
  async #ownedRfq(tx: Prisma.TransactionClient, rfqId: string) {
    const rfq = await tx.rfq.findFirst({
      where: { id: rfqId, orgId: this.#auth.orgId },
      select: { id: true, status: true, mode: true, closesAt: true, orgId: true },
    });
    if (!rfq) {
      throw new RecordNotFoundError("Rfq", rfqId);
    }
    return rfq;
  }
}

/**
 * System sweep: close OPEN auction RFQs whose close time has passed (spec:
 * "auction closes on time"). No actor — audit rows are actorType "system".
 * The conditional update only fires while the RFQ is still OPEN, so a
 * concurrent close/award simply loses the race instead of erroring.
 * A future Inngest schedule calls this; tests call it directly.
 */
export async function closeDueRfqs(db: PrismaClient, at: Date = new Date()) {
  const due = await db.rfq.findMany({
    where: { mode: "AUCTION", status: "OPEN", closesAt: { lte: at } },
    select: { id: true },
  });
  const closed: string[] = [];
  for (const rfq of due) {
    const updated = await db.$transaction(async (tx) => {
      const result = await tx.rfq.updateMany({
        where: { id: rfq.id, status: "OPEN", mode: "AUCTION" },
        data: { status: "CLOSED" },
      });
      if (result.count === 1) {
        await tx.auditLog.create({
          data: {
            orgId: (await tx.rfq.findUniqueOrThrow({ where: { id: rfq.id }, select: { orgId: true } })).orgId,
            actorUserId: null,
            actorType: "system",
            action: RFQ_AUDIT.close,
            entityType: "Rfq",
            entityId: rfq.id,
          },
        });
      }
      return result.count;
    });
    if (updated === 1) {
      closed.push(rfq.id);
    }
  }
  return closed;
}
