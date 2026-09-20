import { notFound, redirect } from "next/navigation";
import {
  availableListingActions,
  parseListingImages,
  RecordNotFoundError,
  type SpecExtractionPayload,
} from "@packsource/core";
import { attributeSetForSlug } from "@packsource/db";
import { listingRepository } from "@/lib/org-scoped";
import { ListingEditor, TransitionBar, type AttributeDef } from "../ui";

/**
 * One listing's editor: draft fields with the category's attribute form,
 * lifecycle transition bar, spec-sheet extraction review, and image
 * suggestion review. Everything is rendered server-side from the
 * org-scoped repository; the client modules handle interaction only.
 */
export default async function ListingEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const repo = await listingRepository();
  if (!repo) {
    redirect("/sign-in");
  }

  const { id } = await params;
  let listing;
  try {
    listing = await repo.listing(id);
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      notFound();
    }
    throw error;
  }

  const set = attributeSetForSlug(listing.category.slug);
  const attributeDefs: AttributeDef[] = (set?.attributes ?? []).map((definition) => ({
    key: definition.key,
    label: definition.label,
    type: definition.type,
    required: definition.required,
    options: definition.options,
    unit: definition.unit,
  }));

  const images = parseListingImages(listing.images).map((entry) => ({
    position: entry.position,
    url: entry.url,
    alt: entry.alt ?? null,
    suggestedTags: entry.suggestedTags ?? null,
    suggestedAlt: entry.suggestedAlt ?? null,
    suggestionStatus: entry.suggestionStatus ?? null,
  }));

  const specSheets = listing.specSheets.map((sheet) => {
    const payload = (sheet.extractedAttributes ?? null) as SpecExtractionPayload | null;
    return {
      id: sheet.id,
      title: sheet.title,
      extractionStatus: sheet.extractionStatus,
      reasoningModel: payload?.reasoningModel ?? null,
      suggestions:
        payload?.suggestions.map((suggestion) => ({
          key: suggestion.key,
          value: suggestion.value,
          confidence: suggestion.confidence,
          evidence: suggestion.evidence,
        })) ?? [],
    };
  });

  const actions = availableListingActions(listing.status);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{listing.title}</h1>
          <p className="text-sm text-neutral-600">
            {listing.category.name} · created{" "}
            {new Date(listing.createdAt).toISOString().slice(0, 10)}
          </p>
        </div>
        <TransitionBar listingId={listing.id} actions={actions} />
      </header>

      <ListingEditor
        listingId={listing.id}
        categorySlug={listing.category.slug}
        attributeDefs={attributeDefs}
        initial={{
          title: listing.title,
          description: listing.description,
          attributes:
            listing.attributes !== null &&
            typeof listing.attributes === "object" &&
            !Array.isArray(listing.attributes)
              ? listing.attributes
              : {},
          stockLevel: listing.stockLevel,
          capacityUnitsPerWeek: listing.capacityUnitsPerWeek,
        }}
        moqTiers={listing.moqTiers.map((tier) => ({
          minQty: tier.minQty,
          unitPriceCents: tier.unitPriceCents,
        }))}
        leadTimeRules={listing.leadTimes.map((rule) => ({
          qtyMin: rule.qtyMin,
          qtyMax: rule.qtyMax,
          productionDays: rule.productionDays,
        }))}
        variants={listing.variants.map((variant) => ({
          sku: variant.sku,
          unitPriceCents: variant.unitPriceCents,
        }))}
        images={images}
        specSheets={specSheets}
      />
    </main>
  );
}
