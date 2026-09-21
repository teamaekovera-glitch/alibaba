import type { ListingSearchDocument } from "@packsource/search";

export type { ListingSearchDocument };

/**
 * Stable, documented JSON shapes for the agent-readable API (spec: agent
 * surface). These mappers are the single source of truth for what agents
 * see: read-only, public listing/supplier data, integer cents, no internal
 * ids leaked beyond stable public identifiers. Field order is fixed by
 * construction so serialized output is deterministic.
 *
 * Listing data is projected from the search document — the same public
 * projection the storefront renders — so the agent surface can never drift
 * ahead of what is actually published.
 */

export interface AgentSupplierRef {
  id: string;
  name: string;
  slug: string;
}

export interface AgentListing {
  id: string;
  slug: string;
  url: string;
  title: string;
  description: string;
  category: { family: string; leaf: string };
  material: string | null;
  sizeBand: string | null;
  moq: { qty: number | null; band: string | null };
  price: { fromCents: number | null; band: string | null };
  leadTimeDays: number | null;
  locations: { cities: string[]; countries: string[] };
  certifications: string[];
  sustainability: string[];
  supplier: AgentSupplierRef;
}

/** Storefront-canonical public path for a listing. */
export function listingUrl(slug: string): string {
  return `/products/${slug}`;
}

export function serializeAgentListing(document: ListingSearchDocument, supplier: AgentSupplierRef): AgentListing {
  return {
    id: document.id,
    slug: document.slug,
    url: listingUrl(document.slug),
    title: document.title,
    description: document.body,
    category: { family: document.categoryFamily, leaf: document.format },
    material: document.material,
    sizeBand: document.sizeBand,
    moq: { qty: document.moqQty, band: document.moqBand },
    price: { fromCents: document.priceCents, band: document.priceBand },
    leadTimeDays: document.leadTimeDays,
    locations: { cities: document.city, countries: document.country },
    certifications: document.certifications,
    sustainability: document.sustainability,
    supplier,
  };
}

export interface AgentSupplierLocation {
  city: string;
  country: string;
  isPrimary: boolean;
}

export interface AgentSupplier {
  id: string;
  name: string;
  slug: string;
  about: string | null;
  verificationStatus: string;
  responseTimeHours: number | null;
  minOrderValueCents: number | null;
  paymentTerms: string;
  locations: AgentSupplierLocation[];
}

export interface AgentSupplierSource {
  id: string;
  name: string;
  slug: string;
  supplierProfile: {
    verificationStatus: string;
    responseTimeHours: number | null;
    minOrderValueCents: number | null;
    paymentTerms: string;
    about: string | null;
    plants: { city: string; country: string; isPrimary: boolean }[];
  } | null;
}

export function serializeAgentSupplier(org: AgentSupplierSource): AgentSupplier {
  const profile = org.supplierProfile;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    about: profile?.about ?? null,
    verificationStatus: profile?.verificationStatus ?? "UNVERIFIED",
    responseTimeHours: profile?.responseTimeHours ?? null,
    minOrderValueCents: profile?.minOrderValueCents ?? null,
    paymentTerms: profile?.paymentTerms ?? "NET_30",
    locations: (profile?.plants ?? []).map((plant) => ({
      city: plant.city,
      country: plant.country,
      isPrimary: plant.isPrimary,
    })),
  };
}

export interface AgentSearchHit {
  /** Relevance score from the active search engine (higher is better). */
  score: number;
  listing: AgentListing;
}

export function serializeAgentSearchHit(document: ListingSearchDocument, supplier: AgentSupplierRef, score: number): AgentSearchHit {
  return { score, listing: serializeAgentListing(document, supplier) };
}
