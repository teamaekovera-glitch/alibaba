import { NextResponse } from "next/server";
import { mail } from "@/lib/adapters";
import { createMagicToken } from "@/lib/magic-link";

/**
 * Issues a magic link for the given email and hands it to the mail adapter.
 * Responds 202 regardless of whether the account exists — the endpoint must
 * not leak account existence. The mock adapter's outbox (visible at
 * /api/dev/inbox in non-production) is what makes this testable with zero
 * API keys.
 */
export async function POST(request: Request): Promise<Response> {
  let email: string | undefined;
  try {
    const body = (await request.json()) as { email?: string };
    email = body.email?.toString().trim().toLowerCase();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  }

  const token = createMagicToken(email);
  const origin = new URL(request.url).origin;
  const link = `${origin}/api/auth/magic-callback?token=${token}`;

  await mail.send({
    to: email,
    subject: "Sign in to PackSource",
    html: `<p>Click to sign in to PackSource:</p><p><a href="${link}">Sign in</a></p><p>This link expires in 15 minutes.</p>`,
  });

  return NextResponse.json({ sent: true }, { status: 202 });
}
