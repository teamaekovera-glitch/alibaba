/**
 * Sample loaders — the only DB-reading code in the package. Both loaders map
 * merged-domain rows into the pure core's sample shapes:
 *
 * - price samples: MOQ price tiers of LIVE listings (the published supply
 *   curve — unit price at each minimum-quantity break), grouped by the
 *   listing's category and its material attribute.
 * - lead-time samples: placed orders (not DRAFT, not CANCELLED) through
 *   their winning quote's production lead time and quantity, grouped by the
 *   RFQ's category (direct or via the referenced listing) and material
 *   attribute when known ("ANY" otherwise).
 */
import type { PrismaClient } from "@packsource/db";
import type { BenchmarkSample, LeadTimeSample } from "./core";
import { qtyBandFor } from "./core";

/** Attribute payloads are Json — only a string material can key a group. */
export function materialOf(attributes: unknown): string | null {
  if (attributes !== null && typeof attributes === "object" && "material" in attributes) {
    const material = (attributes as Record<string, unknown>).material;
    if (typeof material === "string" && material.length > 0) return material;
  }
  return null;
}

/** Loads unit-price samples from the MOQ tiers of live listings. */
export async function loadPriceSamples(db: PrismaClient): Promise<BenchmarkSample[]> {
  const tiers = await db.moqPriceTier.findMany({
    where: { listing: { status: "LIVE" } },
    select: {
      minQty: true,
      unitPriceCents: true,
      listing: { select: { categoryId: true, attributes: true } },
    },
  });

  const samples: BenchmarkSample[] = [];
  for (const tier of tiers) {
    const material = materialOf(tier.listing.attributes);
    if (!material) continue; // group key requires a material
    samples.push({
      categoryId: tier.listing.categoryId,
      qtyBand: qtyBandFor(tier.minQty),
      material,
      unitPriceCents: tier.unitPriceCents,
    });
  }
  return samples;
}

/** Loads lead-time samples from placed orders' winning quotes. */
export async function loadLeadTimeSamples(db: PrismaClient): Promise<LeadTimeSample[]> {
  const orders = await db.order.findMany({
    where: { status: { notIn: ["DRAFT", "CANCELLED"] }, quoteId: { not: null } },
    select: {
      quote: {
        select: {
          quantity: true,
          leadTimeDays: true,
          rfq: {
            select: {
              categoryId: true,
              spec: true,
              listing: { select: { categoryId: true, attributes: true } },
            },
          },
        },
      },
    },
  });

  const samples: LeadTimeSample[] = [];
  for (const order of orders) {
    const quote = order.quote;
    if (!quote) continue;
    const categoryId = quote.rfq.categoryId ?? quote.rfq.listing?.categoryId;
    if (!categoryId) continue;
    const spec = quote.rfq.spec;
    const material =
      materialOf(spec) ?? (quote.rfq.listing ? materialOf(quote.rfq.listing.attributes) : null) ?? "ANY";
    samples.push({
      categoryId,
      qtyBand: qtyBandFor(quote.quantity),
      material,
      leadTimeDays: quote.leadTimeDays,
    });
  }
  return samples;
}
