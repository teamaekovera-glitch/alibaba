/**
 * Server-side listing context for the RFQ creation form: the shared loader
 * behind both the dashboard page mount (deep link from a product page) and
 * the createRfqAction POST. Buyer surfaces only ever quote LIVE listings —
 * a missing, paused, or draft listing yields null and the caller falls back
 * to the plain broadcast form (page) or lets the repository raise the typed
 * "listing no longer live" domain error (action). Kept out of rfq-form.ts so
 * that module stays a pure, unit-testable parser.
 */
import type { RfqListingContext } from "./rfq-form";
import { db } from "@/lib/db";

export async function loadRfqListingContext(listingId: string): Promise<RfqListingContext | null> {
  const row = await db.listing.findUnique({
    where: { id: listingId },
    select: {
      id: true,
      title: true,
      status: true,
      categoryId: true,
      category: { select: { name: true } },
    },
  });
  if (!row || row.status !== "LIVE") {
    return null;
  }
  return { id: row.id, title: row.title, categoryId: row.categoryId, categoryName: row.category.name };
}
