import {
  CartRepository,
  NegotiationRepository,
  QuoteRepository,
  ROLES,
  RfqRepository,
  type AuthContext,
  type Role,
} from "@packsource/core";
import { auth } from "@/auth";
import { db } from "@/lib/db";

/**
 * Trade repositories for the signed-in session. Mirrors org-scoped.ts: the
 * web layer only wires auth -> core; every permission check and org scope
 * lives in packages/core. Returns null when there is no usable session.
 */
export async function tradeRepositories() {
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
    rfq: new RfqRepository(db, authContext),
    quotes: new QuoteRepository(db, authContext),
    negotiation: new NegotiationRepository(db, authContext),
    cart: new CartRepository(db, authContext),
  };
}
