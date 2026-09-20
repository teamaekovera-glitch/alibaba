/**
 * Quote cart, landed-cost comparison, and the award path (spec:
 * "quote cart collecting quotes across suppliers with normalized
 * landed-cost comparison; accept converts to order draft").
 *
 * One cart per buyer org (schema unique). Cart items reference SUBMITTED
 * quotes on the buyer's own RFQs. Accepting a quote: transitions the quote
 * (ACCEPTED), awards the RFQ (AWARDED + pointer), declines the remaining
 * open competitors, and creates the pre-payment Order in DRAFT with
 * integer-cent totals derived from the quote.
 */
import { Prisma, type PrismaClient, type QuoteStatus } from "@packsource/db";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";
import { computeLandedCost, landedCostComponentsFromQuote } from "./landed-cost";
import { quoteTransition } from "./quote-machine";
import { assertCloseTimeAllows, rfqTransition } from "./rfq-machine";
import { InvalidQuoteError, QuoteRepository } from "./quote-repository";

/** Audit-log actions written by the cart/award engine. */
export const TRADE_AUDIT = {
  cartAdd: "cart.add",
  cartRemove: "cart.remove",
  quoteAccept: "quote.accept",
  rfqAward: "rfq.award",
  orderCreate: "order.create",
} as const;

/** Initial pre-payment order state (payments/escrow are a later wave). */
const INITIAL_ORDER_STATUS = "DRAFT" as const;
/** Schema default commission (5%) — kept until the payments wave. */
const DEFAULT_COMMISSION_BPS = 500;

export class CartRepository {
  readonly #db: PrismaClient;
  readonly #auth: AuthContext;
  readonly #quotes: QuoteRepository;

  constructor(db: PrismaClient, auth: AuthContext) {
    this.#db = db;
    this.#auth = auth;
    this.#quotes = new QuoteRepository(db, auth);
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

  // ── cart ──────────────────────────────────────────────────────────────────

  /** Add a submitted quote (on one of this org's RFQs) to the cart. */
  async addToCart(quoteId: string) {
    this.#require("cart:manage");
    return this.#db.$transaction(async (tx) => {
      const quote = await tx.quote.findFirst({
        where: { id: quoteId, rfq: { orgId: this.#auth.orgId } },
        include: { rfq: { select: { id: true, orgId: true } } },
      });
      if (!quote) {
        throw new RecordNotFoundError("Quote", quoteId);
      }
      if (quote.orgId === this.#auth.orgId) {
        throw new InvalidQuoteError("cannot add your own quote to the cart");
      }
      if (quote.status !== "SUBMITTED") {
        throw new InvalidQuoteError(`quote in status ${quote.status} cannot be added to the cart`);
      }
      const cart = await tx.cart.upsert({
        where: { orgId: this.#auth.orgId },
        create: { orgId: this.#auth.orgId },
        update: {},
      });
      const existing = await tx.cartItem.findFirst({
        where: { cartId: cart.id, quoteId: quote.id },
      });
      if (existing) {
        return existing;
      }
      const item = await tx.cartItem.create({
        data: { cartId: cart.id, orgId: this.#auth.orgId, quoteId: quote.id },
      });
      await this.#audit(tx, TRADE_AUDIT.cartAdd, "Quote", quote.id);
      return item;
    });
  }

  /** Remove a cart item (must belong to this org's cart). */
  async removeFromCart(cartItemId: string) {
    this.#require("cart:manage");
    return this.#db.$transaction(async (tx) => {
      const item = await tx.cartItem.findFirst({
        where: { id: cartItemId, orgId: this.#auth.orgId },
      });
      if (!item) {
        throw new RecordNotFoundError("CartItem", cartItemId);
      }
      await tx.cartItem.delete({ where: { id: item.id } });
      await this.#audit(tx, TRADE_AUDIT.cartRemove, "CartItem", item.id);
      return item;
    });
  }

  /**
   * Side-by-side comparison: every cart item with its quote, lines, and
   * landed-cost breakdown at the quoted quantity, cheapest landed total
   * first. This is the buyer's decision surface.
   */
  async listCart() {
    this.#require("cart:manage");
    const cart = await this.#db.cart.findUnique({
      where: { orgId: this.#auth.orgId },
      include: {
        items: {
          include: { quote: { include: { lines: true, org: true, rfq: true } } },
        },
      },
    });
    if (!cart) {
      return [];
    }
    return cart.items
      .map((item) => {
        const quote = item.quote;
        const lines = quote.lines.map((line) => ({
          id: line.id,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          toolingCents: line.toolingCents,
          plateChargesCents: line.plateChargesCents,
          freightCents: line.freightCents,
          totalCents: line.totalCents,
        }));
        return {
          cartItemId: item.id,
          addedAt: item.addedAt,
          quote: {
            id: quote.id,
            org: { id: quote.org.id, name: quote.org.name },
            rfqId: quote.rfqId,
            quantity: quote.quantity,
            unitPriceCents: quote.unitPriceCents,
            toolingCents: quote.toolingCents,
            plateChargesCents: quote.plateChargesCents,
            freightCents: quote.freightCents,
            dutyBps: quote.dutyBps,
            leadTimeDays: quote.leadTimeDays,
            validUntil: quote.validUntil,
            lines,
          },
          landedCost: computeLandedCost(landedCostComponentsFromQuote(quote)),
        };
      })
      .sort((a, b) => a.landedCost.totalCents - b.landedCost.totalCents);
  }

  // ── award path ────────────────────────────────────────────────────────────

  /**
   * Accept a quote: quote -> ACCEPTED, RFQ -> AWARDED with the award
   * pointer, competitors -> DECLINED, and the pre-payment Order (DRAFT)
   * with integer-cent totals + lines. All in one transaction; expired
   * quotes are rejected here.
   */
  async acceptQuote(quoteId: string, at: Date = new Date()) {
    this.#require("order:create");
    return this.#db.$transaction(async (tx) => {
      const quote = await tx.quote.findFirst({
        where: { id: quoteId, rfq: { orgId: this.#auth.orgId } },
        include: {
          lines: true,
          rfq: { select: { id: true, orgId: true, status: true, mode: true, closesAt: true } },
        },
      });
      if (!quote) {
        throw new RecordNotFoundError("Quote", quoteId);
      }
      const rfq = quote.rfq;

      // Guards: validity window + legal transitions + auction close time.
      this.#quotes.assertAcceptableAt(quote, at);
      const nextRfqStatus = rfqTransition(rfq.status, { type: "AWARD", at });
      assertCloseTimeAllows(
        { mode: rfq.mode, closesAt: rfq.closesAt },
        "AWARD",
        at,
      );
      const nextQuoteStatus = quoteTransitionStrict(quote.status, at);

      // 1. Accept the winning quote.
      const accepted = await tx.quote.update({
        where: { id: quote.id },
        data: {
          status: nextQuoteStatus,
          acceptedAt: at,
          acceptedByUserId: this.#auth.userId,
        },
      });

      // 2. Award the RFQ.
      await tx.rfq.update({
        where: { id: rfq.id },
        data: { status: nextRfqStatus, awardedQuoteId: quote.id },
      });
      await this.#audit(tx, TRADE_AUDIT.rfqAward, "Rfq", rfq.id);

      // 3. Decline the remaining open competitors (award ends negotiation).
      const competitors = await tx.quote.findMany({
        where: { rfqId: rfq.id, id: { not: quote.id }, status: "SUBMITTED" },
        select: { id: true },
      });
      for (const competitor of competitors) {
        await tx.quote.update({
          where: { id: competitor.id },
          data: { status: quoteTransitionStrict("SUBMITTED", at, "DECLINE") },
        });
        await this.#audit(tx, "quote.decline", "Quote", competitor.id);
      }

      // 4. Create the pre-payment order (DRAFT) with integer-cent totals.
      const subtotalCents = quote.unitPriceCents * quote.quantity;
      const toolingCents = quote.toolingCents;
      const plateChargesCents = quote.plateChargesCents;
      const freightCents = quote.freightCents;
      const dutyCents = Math.round((subtotalCents * quote.dutyBps) / 10_000);
      const totalCents =
        subtotalCents + toolingCents + plateChargesCents + freightCents + dutyCents;

      const order = await tx.order.create({
        data: {
          orgId: this.#auth.orgId,
          buyerUserId: this.#auth.userId,
          quoteId: quote.id,
          status: INITIAL_ORDER_STATUS,
          paymentSchedule: "FULL_PREPAY",
          subtotalCents,
          toolingCents,
          plateChargesCents,
          freightCents,
          dutyCents,
          taxCents: 0,
          totalCents,
          commissionBps: DEFAULT_COMMISSION_BPS,
          orderLines: {
            create: quoteLinesForOrder(quote),
          },
        },
      });
      await this.#audit(tx, TRADE_AUDIT.quoteAccept, "Quote", quote.id);
      await this.#audit(tx, TRADE_AUDIT.orderCreate, "Order", order.id);

      return { order, quote: accepted, declinedCompetitors: competitors.length };
    });
  }
}

/** Quote machine transition for the accept/decline events. */
function quoteTransitionStrict(status: QuoteStatus, at: Date, event: "ACCEPT" | "DECLINE" = "ACCEPT") {
  return quoteTransition(status, { type: event, at });
}

/** Map a quote's lines to OrderLine create inputs (supplier org). */
function quoteLinesForOrder(
  quote: Prisma.QuoteGetPayload<{ include: { lines: true } }>,
): Prisma.OrderLineUncheckedCreateWithoutOrderInput[] {
  if (quote.lines.length > 0) {
    return quote.lines.map((line) => ({
      orgId: quote.orgId,
      quoteLineId: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      totalCents: line.totalCents,
    }));
  }
  return [
    {
      orgId: quote.orgId,
      description: `Order for RFQ quote ${quote.id}`,
      quantity: quote.quantity,
      unitPriceCents: quote.unitPriceCents,
      totalCents: quote.unitPriceCents * quote.quantity,
    },
  ];
}
