/**
 * Read-path exposure for the fictional-data flag (spec: Trust rules — demo
 * content must be identifiable). The Prisma column lives on Listing
 * (seedIsFictional); these helpers are the shared contract every rendering
 * surface consumes so the "Demo data — fictional" banner stays consistent.
 */

/** Banner copy — the single source of the demo message string. */
export const DEMO_BANNER_MESSAGE = "Demo data — fictional";

/** Minimal shape read paths hand to the banner. */
export interface DemoFlagSource {
  seedIsFictional: boolean;
}

/**
 * Pure decision for whether a rendering surface should show the demo banner.
 * Named + unit-tested so the rule is identical across storefront, admin, and
 * future surfaces.
 */
export function shouldShowDemoBanner(source: DemoFlagSource | null | undefined): boolean {
  return source?.seedIsFictional === true;
}

/** Prisma select fragment including the demo flag, for read paths to spread. */
export const listingDemoFlagSelect = { seedIsFictional: true } as const;
