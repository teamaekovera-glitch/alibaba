import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "PackSource",
  description: "Aekovera CPG packaging marketplace",
};

/**
 * Site chrome: buyer storefront navigation is global so discovery surfaces
 * (search, visual search, compare, co-man) are reachable from every page.
 * Sign-in stays the supplier-console entry point.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-neutral-200 bg-white">
          <nav
            className="mx-auto flex w-full max-w-6xl items-center gap-6 px-4 py-3"
            aria-label="Main"
          >
            <Link href="/" className="font-semibold text-neutral-900">
              PackSource
            </Link>
            <Link href="/search" className="text-sm text-neutral-600 hover:text-neutral-900">
              Search
            </Link>
            <Link href="/search/visual" className="text-sm text-neutral-600 hover:text-neutral-900">
              Visual search
            </Link>
            <Link href="/compare" className="text-sm text-neutral-600 hover:text-neutral-900">
              Compare
            </Link>
            <Link href="/co-man" className="text-sm text-neutral-600 hover:text-neutral-900">
              Co-manufacturing
            </Link>
            <Link
              href="/sign-in"
              className="ml-auto rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              Sign in
            </Link>
          </nav>
        </header>
        <main className="min-h-[calc(100vh-4rem)] bg-neutral-50">{children}</main>
      </body>
    </html>
  );
}
