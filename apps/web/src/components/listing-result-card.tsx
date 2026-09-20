import Link from "next/link";
import type { ListingSearchDocument } from "@packsource/search";
import { formatLeadTimeDays, formatPriceCents, formatQuantity } from "@/lib/format";
import { VerificationBadge } from "./verification-badge";

/**
 * The shared result card for every discovery surface — text search, hybrid,
 * and visual — so all three render identically (spec: visual results land in
 * the normal search UI).
 */
export function ListingResultCard({
  result,
}: {
  result: { document: ListingSearchDocument; similarity?: number };
}) {
  const doc = result.document;
  const location = [doc.city[0], doc.country[0]].filter(Boolean).join(", ");

  return (
    <article
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4"
      data-testid="listing-result-card"
    >
      <Link href={`/products/${doc.slug}`} className="flex gap-4">
        {doc.primaryImageUrl ? (
          // Placeholder art ships as data URIs from the seeder (no remote host),
          // so plain <img> is correct here; next/image cannot optimize data URIs.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={doc.primaryImageUrl}
            alt={doc.title}
            className="h-20 w-20 flex-none rounded-md border border-neutral-100 object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="h-20 w-20 flex-none rounded-md border border-neutral-100 bg-neutral-50"
          />
        )}
        <div className="min-w-0">
          <h3 className="truncate font-medium text-neutral-900">{doc.title}</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {doc.categoryFamily} · {doc.format}
          </p>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-700">
            {doc.priceCents !== null ? (
              <div className="flex gap-1" data-testid="card-price">
                <dt className="text-neutral-500">From</dt>
                <dd className="font-medium">{formatPriceCents(doc.priceCents)}</dd>
              </div>
            ) : null}
            {doc.moqQty !== null ? (
              <div className="flex gap-1" data-testid="card-moq">
                <dt className="text-neutral-500">MOQ</dt>
                <dd>{formatQuantity(doc.moqQty)}</dd>
              </div>
            ) : null}
            {doc.leadTimeDays !== null ? (
              <div className="flex gap-1" data-testid="card-lead-time">
                <dt className="text-neutral-500">Lead time</dt>
                <dd>{formatLeadTimeDays(doc.leadTimeDays)}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <VerificationBadge tier={doc.verificationTier} />
        {doc.certifications.slice(0, 3).map((cert) => (
          <span
            key={cert}
            className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600"
          >
            {cert}
          </span>
        ))}
        {location ? <span className="ml-auto text-xs text-neutral-500">{location}</span> : null}
        {result.similarity !== undefined ? (
          <span
            className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700"
            data-testid="visual-similarity-chip"
          >
            Visually similar · {Math.round(result.similarity * 100)}%
          </span>
        ) : null}
      </div>
    </article>
  );
}
