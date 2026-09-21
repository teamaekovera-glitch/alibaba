import Link from "next/link";
import { initialsFor } from "./visuals";

/**
 * The marketplace grid card for a Platform Ready directory supplier
 * (spec sketch: identity, types, location, certifications, specialty).
 * Presentational and props-driven — pages own the data fetching. Every card
 * links to the read-only profile; no transactional action exists anywhere on
 * a directory surface.
 */
export interface SupplierCardProps {
  supplier: {
    slug: string;
    name: string;
    dba: string | null;
    supplierTypes: string[];
    city: string | null;
    state: string | null;
    certifications: string[];
    specialty: string | null;
    primaryCategory: string;
  };
  /** CSS gradient classes derived from the primary category (see visuals.ts). */
  categoryTint: string;
}

const MAX_TYPE_BADGES = 2;
const MAX_CERT_CHIPS = 3;

export function SupplierCard({ supplier, categoryTint: tint }: SupplierCardProps) {
  const location = [supplier.city, supplier.state].filter(Boolean).join(", ");
  const hiddenTypes = supplier.supplierTypes.length - MAX_TYPE_BADGES;

  return (
    <article
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 transition-colors hover:border-brand-300"
      data-testid={`supplier-card-${supplier.slug}`}
    >
      <Link href={`/directory/${supplier.slug}`} className="flex items-start gap-3">
        <div
          aria-hidden
          className={`flex h-12 w-12 flex-none items-center justify-center rounded-full text-sm font-semibold text-neutral-700 ${tint}`}
        >
          {initialsFor(supplier.name)}
        </div>
        <div className="min-w-0">
          <h3 className="truncate font-medium text-neutral-900">{supplier.name}</h3>
          {supplier.dba ? (
            <p className="mt-0.5 truncate text-xs text-neutral-500">d/b/a {supplier.dba}</p>
          ) : null}
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {supplier.supplierTypes.slice(0, MAX_TYPE_BADGES).map((type) => (
              <li
                key={type}
                className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700"
              >
                {type}
              </li>
            ))}
            {hiddenTypes > 0 ? (
              <li className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-500">
                +{hiddenTypes}
              </li>
            ) : null}
          </ul>
        </div>
      </Link>

      {supplier.specialty ? (
        <p className="line-clamp-2 text-sm text-neutral-600">{supplier.specialty}</p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {supplier.certifications.slice(0, MAX_CERT_CHIPS).map((cert) => (
          <span
            key={cert}
            className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600"
          >
            {cert}
          </span>
        ))}
        {location ? <span className="ml-auto text-xs text-neutral-500">{location}</span> : null}
      </div>
    </article>
  );
}
