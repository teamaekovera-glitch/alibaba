import type { Prisma, PrismaClient } from "@packsource/db";

/**
 * The listing graph a search document is built from: one round of Prisma
 * queries per sync batch, relations included so facet flattening stays pure.
 */

export const listingGraphArgs = {
  include: {
    category: { include: { parent: true } },
    moqTiers: true,
    leadTimes: true,
    complianceClaims: true,
    featuredPlacements: true,
    org: {
      include: {
        supplierProfile: {
          include: {
            certifications: true,
            plants: true,
          },
        },
      },
    },
  },
} satisfies Prisma.ListingDefaultArgs;

export type ListingGraph = Prisma.ListingGetPayload<typeof listingGraphArgs>;

/** Live listings only — discovery never surfaces DRAFT/REJECTED/PAUSED rows. */
export async function loadListingGraphs(
  prisma: PrismaClient,
  listingIds?: string[],
): Promise<ListingGraph[]> {
  return prisma.listing.findMany({
    where: { status: "LIVE", ...(listingIds ? { id: { in: listingIds } } : {}) },
    orderBy: { id: "asc" },
    ...listingGraphArgs,
  });
}
