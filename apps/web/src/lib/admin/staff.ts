/**
 * Staff-context resolution for the admin console (spec: administration —
 * platform-admin gated). Mirrors the lib/orders pattern: one async helper
 * returns the repositories/context or null, and every admin page redirects
 * unauthenticated visitors to /sign-in and renders a forbidden state for
 * signed-in non-admins. `admin:access` is granted only to AEKOVERA_STAFF.
 */
import { can, type AuthContext, type Role } from "@packsource/core";
import { auth } from "@/auth";

/** Resolve the signed-in session into an AuthContext or null. */
export async function sessionAuthContext(): Promise<AuthContext | null> {
  const session = await auth();
  const role = session?.user.role;
  if (!session?.user.id || !role) {
    return null;
  }
  // Staff users hold a membership in the PLATFORM org; a session without one
  // cannot be scoped to any org's audit trail.
  if (!session.user.orgId) {
    return null;
  }
  return { userId: session.user.id, orgId: session.user.orgId, role: role as Role };
}

/** The console gate: true only for roles holding `admin:access`. */
export function isAdminRole(role: string | null | undefined): boolean {
  if (!role) {
    return false;
  }
  try {
    return can(role as Role, "admin:access");
  } catch {
    // Unknown role string (bad session data) — treat as non-admin.
    return false;
  }
}

/**
 * The admin console's auth context, or null when the signed-in user is a
 * guest or lacks `admin:access`. Admin server actions re-gate through the
 * repositories' own assertCan calls on top of this.
 */
export async function staffContext(): Promise<AuthContext | null> {
  const context = await sessionAuthContext();
  if (!context || !isAdminRole(context.role)) {
    return null;
  }
  return context;
}
