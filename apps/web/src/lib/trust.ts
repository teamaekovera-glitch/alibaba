import { DisputesRepository, ReviewsRepository, ROLES, type AuthContext, type Role } from "@packsource/core";
import { db } from "@/lib/db";

/**
 * Trust repositories for the signed-in session. Mirrors messaging.ts: the web
 * layer only wires auth -> core; every permission check, org scope, verified-
 * purchase rule, and redaction lives in packages/core. Returns null when
 * there is no usable session.
 *
 * `@/auth` (next-auth) is imported lazily: anonymous storefront pages render
 * in non-Next contexts (vitest SSR tests) and must not hard-wire next-auth
 * into their module graph.
 */
export async function trustRepositories() {
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user.orgId || !session.user.role) {
    return null;
  }
  const role = ROLES.find((r) => r === session.user.role);
  if (!role) {
    return null;
  }
  const authContext: AuthContext = {
    userId: session.user.id,
    orgId: session.user.orgId,
    role: role as Role,
  };
  return {
    authContext,
    reviews: new ReviewsRepository(db, authContext),
    disputes: new DisputesRepository(db, authContext),
  };
}
