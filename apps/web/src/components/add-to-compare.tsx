"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  COMPARE_COOKIE,
  COMPARE_LIMIT,
  parseCompareSlugs,
  serializeCompareSlugs,
  toggledCompareSlugs,
} from "@/lib/compare-cookie";

function readCompareCookie(): string[] {
  if (typeof document === "undefined") return [];
  const raw = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${COMPARE_COOKIE}=`));
  return parseCompareSlugs(raw?.slice(COMPARE_COOKIE.length + 1));
}

/**
 * Toggle this listing in the buyer's compare tray. The tray lives in a plain
 * cookie so the /compare page can server-render rows without an API surface;
 * router.refresh() re-renders any server components showing tray state.
 */
export function AddToCompareButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<boolean | null>(null);
  const [full, setFull] = useState(false);
  const [pending, startTransition] = useTransition();

  const effectiveSelected = selected ?? readCompareCookie().includes(slug);

  const toggle = () => {
    const current = readCompareCookie();
    const next = toggledCompareSlugs(current, slug);
    if (next.length === current.length && !current.includes(slug)) {
      setFull(true);
      return;
    }
    setFull(false);
    document.cookie = `${COMPARE_COOKIE}=${encodeURIComponent(serializeCompareSlugs(next))}; path=/; max-age=${60 * 60 * 24 * 7}; samesite=lax`;
    setSelected(next.includes(slug));
    startTransition(() => router.refresh());
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        data-testid="add-to-compare"
        aria-pressed={effectiveSelected}
        className={
          effectiveSelected
            ? "rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
            : "rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:border-neutral-900"
        }
      >
        {effectiveSelected ? "In compare — remove" : "Add to compare"}
      </button>
      {full ? (
        <p className="text-xs text-amber-700" role="note">
          Compare tray is full ({COMPARE_LIMIT}). Remove one to add another.
        </p>
      ) : null}
    </div>
  );
}
