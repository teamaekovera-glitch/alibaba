import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDirectorySupplier, getDiscoveryCategory, type PlatformSupplier } from "@packsource/db";
import { db } from "@/lib/db";
import { organizationJsonLd } from "@packsource/seo";

import { JsonLd, pageMetadata, siteOrigin } from "@/lib/seo";
import { avatarGradient, initialsFor } from "@/components/directory/visuals";

/**
 * Read-only profile for one Platform Ready directory supplier (spec:
 * /directory prefix keeps it clear of the transactional /suppliers/[slug]
 * surface). Renders the record as Aeko's prospecting data has it — no RFQ,
 * cart, or messaging action exists here by design; those live exclusively on
 * onboarded Organization pages.
 */
export const dynamic = "force-dynamic";

type DirectoryPageProps = { params: Promise<{ slug: string }> };

async function loadSupplier(slug: string): Promise<PlatformSupplier | null> {
  return getDirectorySupplier(db, slug);
}

export async function generateMetadata({ params }: DirectoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const supplier = await loadSupplier(slug);
  return pageMetadata({
    title: supplier ? `${supplier.name} — PackSource` : "Supplier not found — PackSource",
    description:
      supplier?.description ?? supplier?.specialty ?? "Platform Ready supplier on the PackSource directory.",
    path: `/directory/${slug}`,
    noIndex: !supplier,
  });
}

/** mailto:/tel:/external links — target=_blank + noopener on the external ones. */
function ContactRow({ label, href, external, children }: {
  label: string;
  href: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-28 flex-none text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words text-neutral-800">
        <a
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="text-brand-700 hover:underline"
        >
          {children}
        </a>
      </dd>
    </div>
  );
}

export default async function DirectoryProfilePage({ params }: DirectoryPageProps) {
  const { slug } = await params;
  const supplier = await loadSupplier(slug);
  if (!supplier) notFound();

  const location = [
    supplier.city,
    supplier.state,
    supplier.zip,
    supplier.country,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <JsonLd
        data={organizationJsonLd({
          site: siteOrigin(),
          slug: supplier.slug,
          name: supplier.name,
          about: supplier.description,
          basePath: "/directory",
          locations:
            supplier.city || supplier.country
              ? [{ city: supplier.city ?? "", country: supplier.country ?? "" }]
              : [],
        })}
      />

      <p className="text-sm text-neutral-500">
        <Link href="/" className="hover:underline">
          All categories
        </Link>{" "}
        / <span className="text-neutral-700">Directory</span>
      </p>

      <header className="mt-3 flex flex-wrap items-start gap-4 rounded-lg border border-neutral-200 bg-white p-6">
        <div
          aria-hidden
          className={`flex h-16 w-16 flex-none items-center justify-center rounded-full text-lg font-semibold text-neutral-700 ${avatarGradient(supplier.primaryCategory, supplier.name)}`}
        >
          {initialsFor(supplier.name)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{supplier.name}</h1>
          {supplier.dba ? <p className="mt-0.5 text-sm text-neutral-500">d/b/a {supplier.dba}</p> : null}
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {supplier.supplierTypes.map((type) => (
              <li key={type} className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs text-brand-700">
                {type}
              </li>
            ))}
          </ul>
          {location ? <p className="mt-2 text-sm text-neutral-500">{location}</p> : null}
        </div>
      </header>

      <ul className="mt-4 flex flex-wrap gap-2" data-testid="category-links">
        {supplier.categorySlugs.map((categorySlug) => {
          const category = getDiscoveryCategory(categorySlug);
          return (
            <li key={categorySlug}>
              <Link
                href={`/categories/${categorySlug}`}
                className="inline-block rounded-full border border-neutral-200 bg-white px-3 py-1 text-sm text-neutral-700 hover:border-brand-300 hover:bg-brand-50"
              >
                {category?.name ?? categorySlug}
                {categorySlug === supplier.primaryCategory ? " · primary" : ""}
              </Link>
            </li>
          );
        })}
      </ul>

      {supplier.description ? (
        <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">About</h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-neutral-800">
            {supplier.description}
          </p>
        </section>
      ) : null}

      {supplier.specialty || supplier.products ? (
        <section className="mt-4 grid gap-4 sm:grid-cols-2">
          {supplier.specialty ? (
            <div className="rounded-lg border border-neutral-200 bg-white p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Specialty</h2>
              <p className="mt-2 text-sm text-neutral-800">{supplier.specialty}</p>
            </div>
          ) : null}
          {supplier.products ? (
            <div className="rounded-lg border border-neutral-200 bg-white p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Products</h2>
              <p className="mt-2 text-sm text-neutral-800">{supplier.products}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {supplier.certifications.length > 0 ? (
          <section className="rounded-lg border border-neutral-200 bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Certifications</h2>
            <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="certification-chips">
              {supplier.certifications.map((cert) => (
                <li key={cert} className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-xs text-neutral-600">
                  {cert}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {supplier.primaryEmail ||
        supplier.generalEmail ||
        supplier.phone ||
        supplier.website ||
        supplier.linkedin ? (
          <section className="rounded-lg border border-neutral-200 bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Contact</h2>
            <dl className="mt-2 space-y-1.5" data-testid="contact-block">
              {supplier.primaryEmail ? (
                <ContactRow label="Primary email" href={`mailto:${supplier.primaryEmail}`}>
                  {supplier.primaryEmail}
                </ContactRow>
              ) : null}
              {supplier.generalEmail ? (
                <ContactRow label="General email" href={`mailto:${supplier.generalEmail}`}>
                  {supplier.generalEmail}
                </ContactRow>
              ) : null}
              {supplier.phone ? (
                <ContactRow label="Phone" href={`tel:${supplier.phone.replace(/[^+\d]/g, "")}`}>
                  {supplier.phone}
                </ContactRow>
              ) : null}
              {supplier.website ? (
                <ContactRow label="Website" href={supplier.website} external>
                  {supplier.website}
                </ContactRow>
              ) : null}
              {supplier.linkedin ? (
                <ContactRow label="LinkedIn" href={supplier.linkedin} external>
                  {supplier.linkedin}
                </ContactRow>
              ) : null}
            </dl>
          </section>
        ) : null}
      </div>

      <p className="mt-6 text-center text-xs text-neutral-400">
        Directory record from Aeko&apos;s Platform Ready database — browse-only; quoting and ordering
        run on onboarded PackSource suppliers.
      </p>
    </div>
  );
}
