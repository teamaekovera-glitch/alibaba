import { NextResponse } from "next/server";
import { mail } from "@/lib/adapters";

/**
 * Dev-only mock inbox: every email the MockMailAdapter "sent", newest last.
 * This is what makes the magic-link flow testable end-to-end with zero API
 * keys (Playwright reads the link from here). Hard 404 in production — it
 * must never exist in a deployed environment.
 */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not Found", { status: 404 });
  }
  return NextResponse.json({ outbox: mail.outbox() });
}
