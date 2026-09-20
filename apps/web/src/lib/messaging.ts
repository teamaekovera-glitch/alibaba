import { MessagingRepository, ROLES, type AuthContext, type Role } from "@packsource/core";
import { auth } from "@/auth";
import { db } from "@/lib/db";

/**
 * Messaging repositories for the signed-in session. Mirrors trade.ts: the
 * web layer only wires auth -> core; every permission check, org scope, and
 * redaction rule lives in packages/core. Returns null when there is no
 * usable session.
 */
export async function messagingRepository() {
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
  return { authContext, messaging: new MessagingRepository(db, authContext) };
}
