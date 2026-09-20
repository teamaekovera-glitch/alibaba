import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchExperience } from "@/components/search-experience";

/** Faceted listing discovery over /api/search (client-driven, URL state). */
export const metadata: Metadata = {
  title: "Search packaging — PackSource",
  description: "Faceted, typo-tolerant discovery across verified packaging suppliers.",
};

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-4 py-8">Loading search…</div>}>
      <SearchExperience />
    </Suspense>
  );
}
