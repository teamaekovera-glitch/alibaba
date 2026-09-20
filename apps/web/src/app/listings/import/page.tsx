import { redirect } from "next/navigation";
import { LISTING_IMPORT_COLUMNS } from "@packsource/core";
import { listingRepository } from "@/lib/org-scoped";
import { ImportForm } from "../ui";

/**
 * Bulk listing import. The column contract is exported by
 * packages/core/src/listing-import.ts so the UI table and the validator can
 * never drift apart.
 */
export default async function ImportPage() {
  const repo = await listingRepository();
  if (!repo) {
    redirect("/sign-in");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Bulk import listings</h1>
        <p className="text-sm text-neutral-600">
          Upload a CSV of listings for your organization. Valid rows are imported; rows
          with errors are reported per line and never partially written.
        </p>
      </header>
      <ImportForm
        columns={LISTING_IMPORT_COLUMNS.map((column) => ({
          name: column.name,
          required: column.required,
          description: column.description,
          example: column.example,
        }))}
      />
    </main>
  );
}
