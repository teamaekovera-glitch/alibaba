import type { ReactNode } from "react";

/**
 * Default banner copy. Twin of DEMO_BANNER_MESSAGE in @packsource/db
 * (src/seed/demo.ts) — this package stays db-free, so the literal is mirrored
 * here on purpose.
 */
const DEFAULT_MESSAGE = "Demo data — fictional";

export interface DemoDataBannerProps {
  /** Banner copy. Defaults to the shared demo message. */
  message?: string;
  /** Optional extra content rendered after the message (e.g. a learn-more link). */
  children?: ReactNode;
}

/**
 * Standard "Demo data — fictional" banner for any surface rendering seeded
 * rows (Listing.seedIsFictional). Props-driven so later waves compose it with
 * their own context; the visual treatment stays identical everywhere.
 */
export function DemoDataBanner({ message = DEFAULT_MESSAGE, children }: DemoDataBannerProps) {
  return (
    <div
      role="note"
      aria-label="Demo data notice"
      className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
    >
      <span>{message}</span>
      {children ? <span className="ml-auto">{children}</span> : null}
    </div>
  );
}
