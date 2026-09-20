/**
 * Quote engine — supplier-side submission with MOQ price ladders plus
 * buyer-side reads and lifecycle actions (spec: "RFQ → quote → order").
 *
 * A quote's `lines` carry the price ladder (each line is one tier step:
 * quantity = minQty) or a per-RFQ-line breakdown; the head quote's
 * unit price must equal the ladder price at the quoted quantity. All money
 * is integer cents. Submission requires an RFQ thread (an invite) — a
 * supplier cannot quote an RFQ it was not asked to quote.
 */
import { Prisma, type PrismaClient, type QuoteStatus } from "@packsource/db";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";
import { tierPrice, LandedCostError } from "./landed-cost";
import { redactContactInfo } from "./redaction";
import { isQuoteValidAt } from "./rfq-machine";
import { quoteTransition } from "./quote-machine";

/** Audit-log actions written by the quote engine. */
export const QUOTE_AUDIT = {
  submit: "quote.submit",
  decline: "quote.decline",
  withdraw: "quote.withdraw",
  expire: "quote.expire",
} as const;

/** One ladder step / breakdown line of a submitted quote. */
export interface QuoteLineInput {
  /** The RFQ line this quote line answers, when the RFQ has lines. */
  rfqLineId?: string | null;
  description: string;
  /** Tier minimum quantity (ladder step) or the component quantity. */
  quantity: number;
  unitPriceCents: number;
  toolingCents?: number;
  plateChargesCents?: number;
  freightCents?: number;
}

export interface SubmitQuoteInput {
  rfqId: string;
  /** Defaults to the RFQ's head quantity. */
  quantity?: number;
  leadTimeDays: number;
  validFrom?: Date;
  validUntil: Date;
  /** Duty in basis points (0 = domestic). */
  dutyBps?: number;
  /** The MOQ price ladder / breakdown — at least one line. */
  lines: QuoteLineInput[];
  /** Intro message body — redacted before persistence. */
  message?: string;
}

/** Raised when a quote fails structural validation. */
export class InvalidQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuoteError";
  }
}

/** Raised when a quote is outside its validity window. */
export class QuoteExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteExpiredError";
  }
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidQuoteError(`${name} must be a non-negative integer, got ${value}`);
  }
}

export class QuoteRepository {
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

  // ── submit (supplier) ─────────────────────────────────────────────────────

  /**
   * Submit a quote against an OPEN RFQ the supplier org was invited to.
   * The ladder must price the quoted quantity; the head quote stores the
   * tier price at that quantity and the full ladder as lines.
   */
  async submit(input: SubmitQuoteInput) {
    this.#require("quote:create");
    const at = new Date();
    const validFrom = input.validFrom ?? at;
    if (input.validUntil.getTime() <= validFrom.getTime()) {
      throw new InvalidQuoteError("validUntil must be after validFrom");
    }
    assertNonNegativeInt(input.leadTimeDays, "leadTimeDays");
    if (input.leadTimeDays <= 0) {
      throw new InvalidQuoteError("leadTimeDays must be positive");
    }
    const dutyBps = input.dutyBps ?? 0;
    if (!Number.isInteger(dutyBps) || dutyBps < 0) {
      throw new InvalidQuoteError(`dutyBps must be a non-negative integer, got ${dutyBps}`);
    }
    if (input.lines.length === 0) {
      throw new InvalidQuoteError("a quote needs at least one line (price tier)");
    }
    const seenTiers = new Set<number>();
    for (const line of input.lines) {
      assertNonNegativeInt(line.quantity, "line quantity");
      assertNonNegativeInt(line.unitPriceCents, "line unitPriceCents");
      assertNonNegativeInt(line.toolingCents ?? 0, "line toolingCents");
      assertNonNegativeInt(line.plateChargesCents ?? 0, "line plateChargesCents");
      assertNonNegativeInt(line.freightCents ?? 0, "line freightCents");
      if (line.description.trim().length === 0) {
        throw new InvalidQuoteError("line description is required");
      }
      if (seenTiers.has(line.quantity)) {
        throw new InvalidQuoteError(`duplicate ladder quantity ${line.quantity}`);
      }
      seenTiers.add(line.quantity);
    }

    return this.#db.$transaction(async (tx) => {
      const rfq = await tx.rfq.findFirst({
        where: { id: input.rfqId, status: "OPEN" },
      });
      if (!rfq) {
        // Distinguish "not found" from "not open" for the caller.
        const exists = await tx.rfq.findFirst({ where: { id: input.rfqId }, select: { id: true } });
        if (!exists) {
          throw new RecordNotFoundError("Rfq", input.rfqId);
        }
        throw new InvalidQuoteError("RFQ is not open for quotes");
      }
      const invite = await tx.thread.findFirst({
        where: { rfqId: rfq.id, supplierOrgId: this.#auth.orgId, kind: "RFQ" },
      });
      if (!invite) {
        throw new RecordNotFoundError("RFQ invitation", rfq.id);
      }

      const quantity = input.quantity ?? rfq.quantity ?? null;
      if (quantity === null || !Number.isInteger(quantity) || quantity <= 0) {
        throw new InvalidQuoteError("quote quantity must be a positive integer");
      }
      // The head price is the ladder price at the quoted quantity — a quote
      // below its own first tier is not a quote.
      let headUnitPriceCents: number;
      try {
        headUnitPriceCents = tierPrice(
          input.lines.map((l) => ({ minQty: l.quantity, unitPriceCents: l.unitPriceCents })),
          quantity,
        );
      } catch (error) {
        if (error instanceof LandedCostError) {
          throw new InvalidQuoteError(error.message);
        }
        throw error;
      }

      const quote = await tx.quote.create({
        data: {
          rfqId: rfq.id,
          orgId: this.#auth.orgId,
          salesUserId: this.#auth.userId,
          revision: 1,
          status: quoteTransition("DRAFT", { type: "SUBMIT", at }),
          quantity,
          unitPriceCents: headUnitPriceCents,
          toolingCents: input.lines.reduce((sum, l) => sum + (l.toolingCents ?? 0), 0),
          plateChargesCents: input.lines.reduce((sum, l) => sum + (l.plateChargesCents ?? 0), 0),
          freightCents: input.lines.reduce((sum, l) => sum + (l.freightCents ?? 0), 0),
          dutyBps,
          leadTimeDays: input.leadTimeDays,
          validFrom,
          validUntil: input.validUntil,
          lines: {
            create: input.lines.map((line) => {
              const toolingCents = line.toolingCents ?? 0;
              const plateChargesCents = line.plateChargesCents ?? 0;
              const freightCents = line.freightCents ?? 0;
              return {
                orgId: this.#auth.orgId,
                rfqLineId: line.rfqLineId ?? null,
                description: line.description,
                quantity: line.quantity,
                unitPriceCents: line.unitPriceCents,
                toolingCents,
                plateChargesCents,
                freightCents,
                // Line total: goods + its own one-time fees + freight share.
                totalCents:
                  line.unitPriceCents * line.quantity + toolingCents + plateChargesCents + freightCents,
              };
            }),
          },
        },
      });
      const messageBody = input.message ? redactContactInfo(input.message) : null;
      await tx.negotiationMessage.create({
        data: {
          rfqId: rfq.id,
          quoteId: quote.id,
          orgId: this.#auth.orgId,
          userId: this.#auth.userId,
          kind: "MESSAGE",
          body: messageBody,
        },
      });
      // Mirror the quote into the supplier's own thread as a QUOTE_CARD —
      // thread chats render generic Message rows, not the negotiation log.
      await tx.message.create({
        data: {
          threadId: invite.id,
          orgId: this.#auth.orgId,
          senderUserId: this.#auth.userId,
          kind: "QUOTE_CARD",
          quoteId: quote.id,
          body: messageBody,
        },
      });
      await this.#audit(tx, QUOTE_AUDIT.submit, "Quote", quote.id);
      return quote;
    });
  }

  // ── lifecycle (supplier withdraw / buyer decline) ────────────────────────

  /** Withdraw one of this org's DRAFT/SUBMITTED quotes. */
  async withdraw(quoteId: string, at: Date = new Date()) {
    this.#require("quote:create");
    return this.#db.$transaction(async (tx) => {
      const quote = await tx.quote.findFirst({
        where: { id: quoteId, orgId: this.#auth.orgId },
      });
      if (!quote) {
        throw new RecordNotFoundError("Quote", quoteId);
      }
      const next = quoteTransition(quote.status, { type: "WITHDRAW", at });
      const updated = await tx.quote.update({ where: { id: quote.id }, data: { status: next } });
      await this.#audit(tx, QUOTE_AUDIT.withdraw, "Quote", quote.id);
      return updated;
    });
  }

  /** Decline a submitted quote (buyer side of the RFQ). */
  async decline(quoteId: string, at: Date = new Date()) {
    this.#require("rfq:manage");
    return this.#db.$transaction(async (tx) => {
      const quote = await tx.quote.findFirst({
        where: { id: quoteId, rfq: { orgId: this.#auth.orgId } },
      });
      if (!quote) {
        throw new RecordNotFoundError("Quote", quoteId);
      }
      const next = quoteTransition(quote.status, { type: "DECLINE", at });
      const updated = await tx.quote.update({ where: { id: quote.id }, data: { status: next } });
      await this.#audit(tx, QUOTE_AUDIT.decline, "Quote", quote.id);
      return updated;
    });
  }

  // ── reads (participation-scoped) ─────────────────────────────────────────

  /** Quotes on an RFQ: buyer sees all, supplier sees only its own. */
  async listForRfq(rfqId: string) {
    const rfq = await this.#db.rfq.findFirst({
      where: {
        id: rfqId,
        OR: [
          { orgId: this.#auth.orgId },
          { threads: { some: { supplierOrgId: this.#auth.orgId } } },
        ],
      },
      select: { orgId: true },
    });
    if (!rfq) {
      throw new RecordNotFoundError("Rfq", rfqId);
    }
    const isBuyer = rfq.orgId === this.#auth.orgId;
    return this.#db.quote.findMany({
      where: {
        rfqId,
        ...(isBuyer ? {} : { orgId: this.#auth.orgId }),
      },
      orderBy: { createdAt: "asc" },
      include: { lines: true, org: true },
    });
  }

  /** One quote when the acting org is the quoting supplier or the buyer. */
  async quoteForActor(quoteId: string) {
    const quote = await this.#db.quote.findFirst({
      where: {
        id: quoteId,
        OR: [
          { orgId: this.#auth.orgId },
          { rfq: { orgId: this.#auth.orgId } },
        ],
      },
      include: { lines: true, org: true, rfq: { include: { lines: true } } },
    });
    if (!quote) {
      throw new RecordNotFoundError("Quote", quoteId);
    }
    return quote;
  }

  /**
   * Award-time guard: the quote must be inside its validity window at the
   * accept instant (spec: "rejects expired quotes at accept").
   */
  assertAcceptableAt(
    quote: { validFrom: Date; validUntil: Date; status: QuoteStatus },
    at: Date,
  ): void {
    if (quote.status !== "SUBMITTED" && quote.status !== "ACCEPTED") {
      throw new InvalidQuoteError(`quote in status ${quote.status} cannot be accepted`);
    }
    if (!isQuoteValidAt({ validFrom: quote.validFrom, validUntil: quote.validUntil }, at)) {
      throw new QuoteExpiredError(
        `quote validity ended ${quote.validUntil.toISOString()} — expired quotes are rejected at accept`,
      );
    }
  }
}

/**
 * System sweep: expire SUBMITTED quotes past their validity window.
 * Conditional update only fires while still SUBMITTED, so a concurrent
 * accept/decline/withdraw simply wins the race. Audit rows are actorType
 * "system" on the supplier org.
 */
export async function expireDueQuotes(db: PrismaClient, at: Date = new Date()) {
  const due = await db.quote.findMany({
    where: { status: "SUBMITTED", validUntil: { lt: at } },
    select: { id: true, orgId: true },
  });
  const expired: string[] = [];
  for (const quote of due) {
    const updated = await db.$transaction(async (tx) => {
      const result = await tx.quote.updateMany({
        where: { id: quote.id, status: "SUBMITTED" },
        data: { status: "EXPIRED" },
      });
      if (result.count === 1) {
        await tx.auditLog.create({
          data: {
            orgId: quote.orgId,
            actorUserId: null,
            actorType: "system",
            action: QUOTE_AUDIT.expire,
            entityType: "Quote",
            entityId: quote.id,
          },
        });
      }
      return result.count;
    });
    if (updated === 1) {
      expired.push(quote.id);
    }
  }
  return expired;
}
