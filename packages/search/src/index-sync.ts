import type { QueueAdapter } from "@packsource/ai";
import type { PrismaClient } from "@packsource/db";
import { listingGraphArgs, loadListingGraphs } from "./listing-graph";
import { listingGraphToDocument } from "./facets";
import type { ListingSearchIndex } from "./types";

/**
 * Index synchronization: keeps the listing search index in step with the
 * catalog. Listing writes call `enqueueListingSync` (the spec's Inngest job);
 * the worker handler body is `syncListing`. Full rebuilds (deploy, drift
 * repair) use `syncAllListings`. All paths are idempotent upserts.
 */

/** Queue event name carrying the listing id from write hooks to the worker. */
export const LISTING_SYNC_EVENT = "listing/sync" as const;

export function enqueueListingSync(queue: QueueAdapter, listingId: string): Promise<{ id: string }> {
  return queue.send({ name: LISTING_SYNC_EVENT, data: { listingId } });
}

/** Re-index one listing after a write (the queue handler's body). */
export async function syncListing(
  prisma: PrismaClient,
  index: ListingSearchIndex,
  listingId: string,
  now: Date = new Date(),
): Promise<void> {
  const graphs = await loadListingGraphs(prisma, [listingId]);
  await index.upsert(graphs.map((graph) => listingGraphToDocument(graph, now)));
}

/** Full index (re)build over every live listing, cursor-paginated. */
export async function syncAllListings(
  prisma: PrismaClient,
  index: ListingSearchIndex,
  options: { batchSize?: number; now?: Date } = {},
): Promise<{ indexed: number }> {
  const batchSize = options.batchSize ?? 200;
  const now = options.now ?? new Date();

  let cursorId: string | undefined;
  let indexed = 0;

  for (;;) {
    const graphs = await prisma.listing.findMany({
      where: { status: "LIVE" },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      ...listingGraphArgs,
    });
    if (graphs.length === 0) {
      break;
    }
    await index.upsert(graphs.map((graph) => listingGraphToDocument(graph, now)));
    indexed += graphs.length;
    const last = graphs[graphs.length - 1];
    if (!last || graphs.length < batchSize) {
      break;
    }
    cursorId = last.id;
  }

  return { indexed };
}
