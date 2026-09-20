/**
 * Normalized landed cost — the marketplace's core fairness mechanic (spec:
 * "RFQ → quote → order"). Any supplier quote normalizes to a single
 * comparable all-in number: tier price × quantity + one-time costs amortized
 * over the quantity + per-unit freight + duty.
 *
 * All money is integer cents; the rounding points are fixed so two quotes
 * always compare on the same normalized basis. The formula mirrors the spec's
 * reference implementation exactly; duty is stored in basis points (schema:
 * Quote.dutyBps) so duty per unit is `round(unit × dutyBps / 10_000)` — the
 * integer-cent equivalent of the spec's `round(unit × dutyPct)`.
 */
import type { Prisma } from "@packsource/db";

/** One step of a supplier's MOQ price ladder (schema: MoqPriceTier). */
export interface MoqTier {
  minQty: number;
  unitPriceCents: number;
}

/**
 * Everything computeLandedCost needs to normalize a quote. Shape mirrors
 * the spec's QuoteComponents with schema-faithful field names.
 */
export interface QuoteCostComponents {
  quantity: number;
  moqTiers: MoqTier[];
  toolingCents: number; // one-time; amortized across quantity
  plateChargesCents: number; // one-time per SKU/color
  freightCents: number; // estimate unless negotiated otherwise
  dutyBps: number; // 1 bp = 0.01%; 0 for domestic
}

export interface LandedCostBreakdownEntry {
  key: keyof QuoteCostComponents;
  cents: number;
  note?: string;
}

export interface LandedCost {
  unitLandedCents: number; // all-in per-unit
  totalCents: number;
  oneTimeCents: number;
  breakdown: LandedCostBreakdownEntry[];
}

/** Raised for non-positive quantities or an empty/broken price ladder. */
export class LandedCostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LandedCostError";
  }
}

/**
 * Resolve the tier price for a quantity: the price of the highest tier whose
 * minimum quantity is at or below it. Throws when the quantity is below the
 * first tier — a quote below MOQ is not a quote.
 */
export function tierPrice(tiers: MoqTier[], quantity: number): number {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new LandedCostError(`quantity must be a positive integer, got ${quantity}`);
  }
  if (tiers.length === 0) {
    throw new LandedCostError("quote has no price tiers");
  }
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  let resolved: MoqTier | undefined;
  for (const tier of sorted) {
    if (tier.minQty <= quantity) {
      resolved = tier;
    } else {
      break;
    }
  }
  if (!resolved) {
    const first = sorted[0];
    throw new LandedCostError(
      `quantity ${quantity} is below the first MOQ tier (minQty ${first ? first.minQty : "?"})`,
    );
  }
  if (!Number.isInteger(resolved.unitPriceCents) || resolved.unitPriceCents < 0) {
    throw new LandedCostError(`tier at minQty ${resolved.minQty} has an invalid unit price`);
  }
  return resolved.unitPriceCents;
}

/**
 * Normalize any supplier quote to a single comparable all-in number.
 * One-time costs amortize over quantity (not per unit at 1k vs 100k — the
 * ladder already tiers unit price; tooling/plates do not tier).
 */
export function computeLandedCost(q: QuoteCostComponents): LandedCost {
  const unit = tierPrice(q.moqTiers, q.quantity);
  const goods = unit * q.quantity;
  const oneTime = q.toolingCents + q.plateChargesCents;
  const freight = Math.round(q.freightCents / q.quantity); // per-unit freight
  const duty = Math.round((unit * q.dutyBps) / 10_000);
  const amortizedOneTime = Math.round(oneTime / q.quantity);
  const unitLanded = unit + freight + duty + amortizedOneTime;
  return {
    unitLandedCents: unitLanded,
    // Total bills full freight once (not the rounded per-unit estimate × qty).
    totalCents: goods + oneTime + q.freightCents + duty * q.quantity,
    oneTimeCents: oneTime,
    breakdown: [
      { key: "moqTiers", cents: unit, note: "tier price" },
      { key: "toolingCents", cents: amortizedOneTime, note: "amortized one-time (tooling + plates)" },
      { key: "freightCents", cents: freight, note: "per-unit freight" },
      { key: "dutyBps", cents: duty, note: "duty at quoted bps" },
    ],
  };
}

/**
 * Build components from a persisted Quote row: the price ladder comes from
 * the quote's lines (each line is one tier step — minQty = line quantity),
 * one-time fees and freight roll up from the lines. When a quote has no
 * lines the head money stands alone as a single-tier offer.
 */
export function landedCostComponentsFromQuote(quote: {
  quantity: number;
  unitPriceCents: number;
  toolingCents: number;
  plateChargesCents: number;
  freightCents: number;
  dutyBps: number;
  lines: {
    quantity: number;
    unitPriceCents: number;
    toolingCents: number;
    plateChargesCents: number;
    freightCents: number;
  }[];
}): QuoteCostComponents {
  if (quote.lines.length === 0) {
    return {
      quantity: quote.quantity,
      moqTiers: [{ minQty: quote.quantity, unitPriceCents: quote.unitPriceCents }],
      toolingCents: quote.toolingCents,
      plateChargesCents: quote.plateChargesCents,
      freightCents: quote.freightCents,
      dutyBps: quote.dutyBps,
    };
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    quantity: quote.quantity,
    moqTiers: quote.lines.map((line) => ({
      minQty: line.quantity,
      unitPriceCents: line.unitPriceCents,
    })),
    toolingCents: sum(quote.lines.map((line) => line.toolingCents)),
    plateChargesCents: sum(quote.lines.map((line) => line.plateChargesCents)),
    freightCents: sum(quote.lines.map((line) => line.freightCents)),
    dutyBps: quote.dutyBps,
  };
}

/** Prisma JSON guard: narrowed read of an Rfq.spec document. */
export function asRecord(value: Prisma.JsonValue | null): Prisma.JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.JsonObject)
    : null;
}
