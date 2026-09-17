import { AuthError } from "next-auth";
import { NextResponse } from "next/server";
import { signIn } from "@/auth";
import { verifyMagicToken } from "@/lib/magic-link";

/**
 * Magic-link landing: verifies the HMAC token, signs the user in through the
 * credentials provider, and redirects home. Invalid or expired tokens land
 * back on the sign-in page with an error flag — never an error page.
 */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const verified = token ? verifyMagicToken(token) : null;

  if (!verified) {
    return NextResponse.redirect(new URL("/sign-in?error=invalid_link", request.url));
  }

  try {
    await signIn("credentials", { email: verified.email, magicToken: token! }, { redirectTo: "/" });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.redirect(new URL("/sign-in?error=sign_in_failed", request.url));
    }
    throw error; // NEXT_REDIRECT (success) and framework errors must propagate
  }

  return NextResponse.redirect(new URL("/", request.url));
}
