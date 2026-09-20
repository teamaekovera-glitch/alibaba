/**
 * Negotiation engine — threaded counter-offers on RFQ threads (spec:
 * "threaded counter-offers with an explicit state machine"). A supplier
 * counter creates a revision quote (parent → SUPERSEDED, child → SUBMITTED,
 * revision = parent + 1); a buyer counter-request is a COUNTER_OFFER
 * message with structured terms the supplier answers with a revision.
 *
 * Contact-sharing restriction (spec): message bodies are redacted on write
 * — emails/phones never reach the database in message content — and SYSTEM
 * messages are reserved for the platform.
 */
import { Prisma, type NegotiationMessageKind, type PrismaClient, type Thread } from "@packsource/db";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";
import { redactContactInfo } from "./redaction";
import { quoteTransition } from "./quote-machine";
import { QUOTE_AUDIT } from "./quote-repository";

/** Audit-log actions written by the negotiation engine. */
export const NEGOTIATION_AUDIT = {
  message: "negotiation.message",
  counter: "negotiation.counter",
} as const;

/** User-postable message kinds — SYSTEM is platform-only. */
const USER_POSTABLE_KINDS: readonly NegotiationMessageKind[] = ["MESSAGE", "COUNTER_OFFER"];

export interface PostMessageInput {
  kind: Exclude<NegotiationMessageKind, "SYSTEM">;
  /** Free text — redacted before persistence. */
  body?: string;
  /** Structured counter terms (unitPriceCents, toolingCents, leadTimeDays…). */
  terms?: Record<string, string | number | boolean>;
}

export interface CounterQuoteInput {
  /** Terms carried on the COUNTER_OFFER message and the revision quote. */
  quantity?: number;
  unitPriceCents?: number;
  toolingCents?: number;
  plateChargesCents?: number;
  freightCents?: number;
  dutyBps?: number;
  leadTimeDays?: number;
  validUntil?: Date;
  message?: string;
}

/** Redact every string value in a terms record (defense in depth). */
function redactTerms(terms: Record<string, string | number | boolean>): Prisma.InputJsonValue {
  return Object.fromEntries(
    Object.entries(terms).map(([key, value]) => [
      key,
      typeof value === "string" ? redactContactInfo(value) : value,
    ]),
  );
}

export class NegotiationRepository {
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
    entityId: string,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId: this.#auth.orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType: "NegotiationMessage",
        entityId,
      },
    });
  }

  /**
   * Load a thread the acting org participates in (buyer or invited supplier).
   * Negotiation threads always reference an RFQ — a thread without one is
   * not a valid negotiation surface, so it's treated as missing.
   */
  async #participatingThread(tx: Prisma.TransactionClient, threadId: string): Promise<Thread & { rfqId: string }> {
    const found = await tx.thread.findFirst({
      where: {
        id: threadId,
        OR: [
          { buyerOrgId: this.#auth.orgId },
          { supplierOrgId: this.#auth.orgId },
        ],
      },
    });
    if (!found || found.rfqId === null) {
      throw new RecordNotFoundError("Thread", threadId);
    }
    const thread: Thread & { rfqId: string } = { ...found, rfqId: found.rfqId };
    return thread;
  }

  /** Post a message on a negotiation thread. Body/term strings are redacted. */
  async postMessage(threadId: string, input: PostMessageInput) {
    this.#require("message:send");
    if (!USER_POSTABLE_KINDS.includes(input.kind)) {
      throw new Error(`kind ${input.kind} is reserved for the platform`);
    }
    const hasBody = typeof input.body === "string" && input.body.trim().length > 0;
    const hasTerms = input.terms !== undefined && Object.keys(input.terms).length > 0;
    if (input.kind === "COUNTER_OFFER" && !hasTerms) {
      throw new Error("a COUNTER_OFFER requires structured terms");
    }
    if (!hasBody && !hasTerms) {
      throw new Error("a message needs a body or terms");
    }

    return this.#db.$transaction(async (tx) => {
      const thread = await this.#participatingThread(tx, threadId);
      const message = await tx.negotiationMessage.create({
        data: {
          rfqId: thread.rfqId,
          orgId: this.#auth.orgId,
          userId: this.#auth.userId,
          kind: input.kind,
          body: input.body ? redactContactInfo(input.body) : null,
          terms: input.terms ? redactTerms(input.terms) : Prisma.JsonNull,
        },
      });
      await this.#audit(tx, NEGOTIATION_AUDIT.message, message.id);
      return message;
    });
  }

  /**
   * Supplier counter-offer: supersede the current head quote with a revision
   * (child quote via parentQuoteId, revision = head + 1) and post a
   * COUNTER_OFFER message with the terms. The revision starts SUBMITTED so
   * the buyer can accept it directly.
   */
  async counterQuote(quoteId: string, input: CounterQuoteInput) {
    this.#require("quote:create");
    const at = new Date();

    return this.#db.$transaction(async (tx) => {
      const head = await tx.quote.findFirst({
        where: { id: quoteId, orgId: this.#auth.orgId },
        include: { rfq: { select: { id: true, status: true, quantity: true } } },
      });
      if (!head) {
        throw new RecordNotFoundError("Quote", quoteId);
      }
      const nextChild = quoteTransition(head.status, { type: "SUPERSEDE", at });
      if (head.rfq.status !== "OPEN") {
        throw new Error("RFQ is not open for negotiation");
      }
      if (input.validUntil && input.validUntil.getTime() <= at.getTime()) {
        throw new Error("counter validUntil must be in the future");
      }
      // Only one child revision can exist per parent (schema unique).
      const existingRevision = await tx.quote.findFirst({
        where: { parentQuoteId: head.id },
        select: { id: true },
      });
      if (existingRevision) {
        throw new Error("this quote already has a pending revision");
      }

      const quantity = input.quantity ?? head.quantity;
      const unitPriceCents = input.unitPriceCents ?? head.unitPriceCents;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`counter quantity must be a positive integer, got ${quantity}`);
      }
      if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
        throw new Error(`counter unitPriceCents must be a non-negative integer, got ${unitPriceCents}`);
      }
      const toolingCents = input.toolingCents ?? head.toolingCents;
      const plateChargesCents = input.plateChargesCents ?? head.plateChargesCents;
      const freightCents = input.freightCents ?? head.freightCents;
      const dutyBps = input.dutyBps ?? head.dutyBps;
      const leadTimeDays = input.leadTimeDays ?? head.leadTimeDays;

      const revision = await tx.quote.create({
        data: {
          rfqId: head.rfqId,
          orgId: this.#auth.orgId,
          salesUserId: this.#auth.userId,
          parentQuoteId: head.id,
          revision: head.revision + 1,
          status: quoteTransition("DRAFT", { type: "SUBMIT", at }),
          quantity,
          unitPriceCents,
          toolingCents,
          plateChargesCents,
          freightCents,
          dutyBps,
          leadTimeDays,
          validFrom: at,
          validUntil: input.validUntil ?? head.validUntil,
          lines: {
            create: {
              orgId: this.#auth.orgId,
              description: `Revision ${head.revision + 1} of quote ${head.id}`,
              quantity,
              unitPriceCents,
              toolingCents,
              plateChargesCents,
              freightCents,
              totalCents:
                unitPriceCents * quantity + toolingCents + plateChargesCents + freightCents,
            },
          },
        },
      });

      await tx.quote.update({
        where: { id: head.id },
        data: { status: nextChild },
      });
      const message = await tx.negotiationMessage.create({
        data: {
          rfqId: head.rfqId,
          quoteId: revision.id,
          orgId: this.#auth.orgId,
          userId: this.#auth.userId,
          kind: "COUNTER_OFFER",
          body: input.message ? redactContactInfo(input.message) : null,
          terms: redactTerms({
            quantity,
            unitPriceCents,
            toolingCents,
            plateChargesCents,
            freightCents,
            dutyBps,
            leadTimeDays,
          }),
        },
      });
      await this.#audit(tx, NEGOTIATION_AUDIT.counter, message.id);
      await tx.auditLog.create({
        data: {
          orgId: this.#auth.orgId,
          actorUserId: this.#auth.userId,
          actorType: "user",
          action: QUOTE_AUDIT.submit,
          entityType: "Quote",
          entityId: revision.id,
        },
      });
      return { revision, head, message };
    });
  }

  /** Thread history oldest-first, for the negotiation panel. */
  async threadMessages(threadId: string) {
    this.#require("message:send");
    const thread = await this.#participatingThread(this.#db, threadId);
    return this.#db.negotiationMessage.findMany({
      where: { rfqId: thread.rfqId, OR: [{ quoteId: thread.id }, { quote: { rfqId: thread.rfqId } }] },
      orderBy: { createdAt: "asc" },
    });
  }
}
