import { redirect } from "next/navigation";
import { attributeSetForSlug, flattenTaxonomy } from "@packsource/db";
import { listingRepository } from "@/lib/org-scoped";
import { CreateListingForm, type AttributeDef, type CategoryOption } from "../ui";

/**
 * Create-listing page. Category definitions and their attribute forms come
 * straight from the taxonomy (the same source the category table and the Zod
 * validators are built from), serialised down to the client form.
 */
export default async function NewListingPage() {
  const repo = await listingRepository();
  if (!repo) {
    redirect("/sign-in");
  }

  const categories: CategoryOption[] = flattenTaxonomy().map(({ slug, name }) => {
    const set = attributeSetForSlug(slug);
    const attributes: AttributeDef[] = (set?.attributes ?? []).map((definition) => ({
      key: definition.key,
      label: definition.label,
      type: definition.type,
      required: definition.required,
      options: definition.options,
      unit: definition.unit,
    }));
    return { slug, name, attributes };
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New listing</h1>
        <p className="text-sm text-neutral-600">
          Pick a category — the form shows that category&apos;s required attributes. Drafts
          can be saved incomplete and submitted for review later.
        </p>
      </header>
      <CreateListingForm categories={categories} />
    </main>
  );
}
