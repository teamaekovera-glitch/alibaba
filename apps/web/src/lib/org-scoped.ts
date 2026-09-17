import { OrgScopedRepository, ROLES, type AuthContext, type Role } from "@packsource/core";
import { auth } from "@/auth";
import { db } from "@/lib/db";

/**
 * Builds the org-scoped repository for the signed-in session. Every read and
 * write through this repository is permission-gated and org-scoped in
 * packages/core — the web layer never touches Prisma directly for domain
 * data, so tenancy cannot leak by forgetting a `where` clause.
 *
 * Returns null when there is no session (the caller redirects) or the
 * session's role is not a known role.
 */
export async function orgScopedRepository(): Promise<OrgScopedRepository | null> {
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
  return new OrgScopedRepository(db, authContext);
}
