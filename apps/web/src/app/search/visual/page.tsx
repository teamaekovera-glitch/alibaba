"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DemoDataBanner } from "@packsource/ui";
import { normalizeSearchPayload, type NormalizedSearch } from "@/lib/search-client";
import { ListingResultCard } from "@/components/listing-result-card";

/**
 * Visual search entry (spec §discovery): the buyer uploads a reference image;
 * it flows through the storage adapter (zero-key R2 mock by default) into
 * /api/search/visual and the results render in the same list as text search.
 */
export default function VisualSearchPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "searching">("idle");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<NormalizedSearch | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setSearch(null);
    setStatus("uploading");
    setPreviewUrl(URL.createObjectURL(file));

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Chunked base64 — avoids call-stack limits on real photo sizes.
      let binary = "";
      const chunk = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
      }
      setStatus("searching");
      const response = await fetch("/api/search/visual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base64: btoa(binary),
          mimeType: file.type || "image/png",
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(
          typeof payload === "object" && payload !== null && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `Visual search failed (${response.status}).`,
        );
        return;
      }
      const normalized = normalizeSearchPayload(payload);
      if (normalized.ok) {
        setSearch(normalized);
      } else {
        setError(normalized.error);
      }
    } catch {
      setError("Upload failed — check the file and try again.");
    } finally {
      setStatus("idle");
    }
  }

  const busy = status !== "idle";

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8" data-testid="visual-search-page">
      <DemoDataBanner surface="buyer storefront visual search" />
      <h1 className="text-xl font-semibold text-neutral-900">Search by image</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Upload a photo of the packaging you need — we find visually similar listings.
      </p>

      <form
        className="mt-6 rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-center"
        data-testid="visual-upload-form"
        onSubmit={(event) => event.preventDefault()}
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Uploaded reference"
            className="mx-auto h-32 rounded-md border border-neutral-100 object-contain"
            data-testid="visual-preview"
          />
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
          data-testid="visual-file-input"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="visual-choose-button"
        >
          {status === "uploading" ? "Uploading…" : status === "searching" ? "Searching…" : "Choose an image"}
        </button>
        <p className="mt-2 text-xs text-neutral-400">PNG or JPG. Nothing is persisted beyond this demo session.</p>
      </form>

      {error ? (
        <div
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          data-testid="visual-error-state"
        >
          {error}
        </div>
      ) : null}

      {search ? (
        search.results.length === 0 ? (
          <div
            className="mt-6 rounded-lg border border-neutral-200 bg-white p-8 text-center"
            data-testid="visual-empty-state"
          >
            <h2 className="font-medium text-neutral-900">No similar listings found</h2>
            <p className="mt-1 text-sm text-neutral-500">Try a clearer photo or a different angle.</p>
            <Link href="/search" className="mt-3 inline-block text-sm text-brand-700 hover:underline">
              Or search by text →
            </Link>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-3" data-testid="visual-results">
            {search.results.map((result) => (
              <ListingResultCard key={result.document.id} result={result} />
            ))}
          </div>
        )
      ) : null}

      <button
        type="button"
        onClick={() => router.push("/search")}
        className="mt-6 text-sm text-neutral-500 hover:underline"
      >
        ← Back to text search
      </button>
    </div>
  );
}
