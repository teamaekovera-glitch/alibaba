import Link from "next/link";
import { Button } from "@packsource/ui";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">PackSource</h1>
      <p className="text-lg text-neutral-600">
        Packaging marketplace scaffold — discovery, RFQ, and protected purchasing for CPG
        brands.
      </p>
      <div className="flex gap-3">
        <Link href="/health">
          <Button>Health check</Button>
        </Link>
        <Link
          href="/listings"
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Listing console
        </Link>
      </div>
    </main>
  );
}
