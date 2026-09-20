"use server";

import {
  IllegalQuoteTransitionError,
  IllegalRfqTransitionError,
  InvalidQuoteError,
  InvalidRfqError,
  LandedCostError,
  PermissionDeniedError,
  QuoteExpiredError,
  RecordNotFoundError,
} from "@packsource/core";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { tradeRepositories } from "@/lib/trade";

/**
 * RFQ/quote/negotiation/cart server actions. Same contract as onboarding:
 * handlers parse FormData and translate domain errors into form-renderable
 * messages — every permission gate and org scope lives in packages/core.
 */

export type ActionState = { ok: true; message?: string } | { error: string } | null;

const DOMAIN_ERRORS = [
  PermissionDeniedError,
  RecordNotFoundError,
  InvalidRfqError,
  IllegalRfqTransitionError,
  InvalidQuoteError,
  IllegalQuoteTransitionError,
  QuoteExpiredError,
  LandedCostError,
] as const;

async function withTrade(
  run: (
    trade: NonNullable<Awaited<ReturnType<typeof tradeRepositories>>>,
  ) => Promise<string | void>,
): Promise<ActionState> {
  const trade = await tradeRepositories();
  if (!trade) {
    redirect("/sign-in");
  }
  try {
    const result = await run(trade);
    revalidatePath("/rfq");
    revalidatePath("/cart");
    return { ok: true, message: typeof result === "string" ? result : undefined };
  } catch (error) {
    if (DOMAIN_ERRORS.some((kind) => error instanceof kind)) {
      return { error: error instanceof Error ? error.message : "Action failed" };
    }
    throw error; // unknown errors must surface, not become form copy
  }
}

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optional(form: FormData, key: string): string | null {
  const value = str(form, key);
  return value.length > 0 ? value : null;
}

function requiredInt(form: FormData, key: string): number {
  const value = Number.parseInt(str(form, key), 10);
  if (!Number.isInteger(value)) {
    throw new InvalidRfqError(`${key} must be a whole number`);
  }
  return value;
}

/**
 * Decimal-dollar form input -> integer cents, parsed from the string (never
 * via float arithmetic — money never touches a double).
 */
function dollarsToCents(form: FormData, key: string): number | null {
  const raw = str(form, key);
  if (!raw) {
    return null;
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match || !match[1]) {
    throw new InvalidQuoteError(`${key} must be a dollar amount like 12.34`);
  }
  const dollars = Number.parseInt(match[1], 10);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = fraction.length === 0 ? 0 : Number.parseInt(fraction, 10);
  return dollars * 100 + cents;
}

function isoDate(form: FormData, key: string): Date | null {
  const value = str(form, key);
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidRfqError(`${key} must be a valid date`);
  }
  return date;
}

// ── buyer RFQ actions ───────────────────────────────────────────────────────

export async function createRfqAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ rfq }) => {
    const mode = str(form, "mode");
    if (mode !== "BROADCAST" && mode !== "AUCTION" && mode !== "SINGLE") {
      throw new InvalidRfqError("RFQ mode must be BROADCAST, AUCTION, or SINGLE");
    }
    const needBy = isoDate(form, "needBy");
    const destination = optional(form, "destination");
    const created = await rfq.create({
      mode,
      title: str(form, "title"),
      description: optional(form, "description"),
      categoryId: optional(form, "categoryId"),
      listingId: optional(form, "listingId"),
      quantity: str(form, "quantity") ? requiredInt(form, "quantity") : undefined,
      closesAt: isoDate(form, "closesAt") ?? undefined,
      spec: {
        destination: destination ?? undefined,
        needBy: needBy ? needBy.toISOString().slice(0, 10) : undefined,
      },
      lines: [
        {
          description: str(form, "lineDescription") || str(form, "title"),
          quantity: requiredInt(form, "quantity"),
        },
      ],
    });
    return created.id;
  });
}

export async function sendRfqAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ rfq }) => {
    await rfq.send(str(form, "rfqId"));
  });
}

export async function cancelRfqAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ rfq }) => {
    await rfq.cancel(str(form, "rfqId"));
  });
}

// ── supplier quote actions ──────────────────────────────────────────────────

export async function submitQuoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ quotes }) => {
    const unitPriceCents = dollarsToCents(form, "unitPrice");
    if (unitPriceCents === null) {
      throw new InvalidQuoteError("unit price is required");
    }
    const quantity = requiredInt(form, "quantity");
    const lines = [
      {
        description: str(form, "description") || `Quote tier @ ${quantity} units`,
        quantity,
        unitPriceCents,
      },
    ];
    const tier2Qty = optional(form, "tier2Qty");
    const tier2Price = dollarsToCents(form, "tier2Price");
    if (tier2Qty && tier2Price !== null) {
      lines.push({
        description: `Quote tier @ ${tier2Qty} units`,
        quantity: Number.parseInt(tier2Qty, 10),
        unitPriceCents: tier2Price,
      });
    }
    const validUntil = isoDate(form, "validUntil");
    if (!validUntil) {
      throw new InvalidQuoteError("valid-until date is required");
    }
    await quotes.submit({
      rfqId: str(form, "rfqId"),
      quantity,
      leadTimeDays: requiredInt(form, "leadTimeDays"),
      validUntil,
      dutyBps: 0,
      lines,
      message: optional(form, "message") ?? undefined,
    });
  });
}

export async function counterQuoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ negotiation }) => {
    await negotiation.counterQuote(str(form, "quoteId"), {
      quantity: str(form, "quantity") ? requiredInt(form, "quantity") : undefined,
      unitPriceCents: dollarsToCents(form, "unitPrice") ?? undefined,
      message: optional(form, "message") ?? undefined,
    });
  });
}

export async function withdrawQuoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ quotes }) => {
    await quotes.withdraw(str(form, "quoteId"));
  });
}

// ── negotiation ─────────────────────────────────────────────────────────────

export async function postMessageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ negotiation }) => {
    await negotiation.postMessage(str(form, "threadId"), {
      kind: "MESSAGE",
      body: str(form, "body"),
    });
  });
}

// ── buyer quote decisions + cart ────────────────────────────────────────────

export async function declineQuoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ quotes }) => {
    await quotes.decline(str(form, "quoteId"));
  });
}

export async function addToCartAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ cart }) => {
    await cart.addToCart(str(form, "quoteId"));
  });
}

export async function removeFromCartAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ cart }) => {
    await cart.removeFromCart(str(form, "cartItemId"));
  });
}

export async function acceptQuoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return withTrade(async ({ cart }) => {
    const { order } = await cart.acceptQuote(str(form, "quoteId"));
    return `Order ${order.id} created — ready for the payments wave`;
  });
}
