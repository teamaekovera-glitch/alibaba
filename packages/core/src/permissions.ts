/**
 * Central permission definitions and the role → permission matrix
 * (spec: "Multi-tenancy and roles").
 *
 * Roles are scoped per OrgMembership — the same person can be a BUYER in one
 * organization and SUPPLIER_SALES in another — so a permission check always
 * happens against one membership's role, and every domain query flows through
 * permission-gated repository functions that filter by the acting user's
 * orgId (see repositories.ts). Postgres row-level security is a hardening
 * step, not the primary gate.
 *
 * Later workstreams extend PERMISSIONS and the matrix; they never branch on
 * role strings at call sites — that coupling lives only here.
 */

/** Membership roles, mirroring the schema's `OrgRole` enum. */
export const ROLES = [
  // Buyer orgs
  "OWNER",
  "ADMIN",
  "BUYER",
  "APPROVER",
  // Supplier orgs
  "SUPPLIER_SALES",
  "SUPPLIER_OPS",
  // Platform
  "AEKOVERA_STAFF",
] as const;

export type Role = (typeof ROLES)[number];

/** Every grantable action, named `<domain>:<action>`. */
export const PERMISSIONS = [
  // Buyer-side discovery and trade
  "catalog:search",
  "workspace:manage",
  "rfq:create",
  "rfq:manage",
  "cart:manage",
  "order:create",
  "order:approve",
  "sample:order",
  // Supplier-side console
  "supplier:onboard",
  "profile:manage",
  "listing:manage",
  "quote:create",
  "shipment:manage",
  // Platform staff
  "supplier:verify",
  "moderation:manage",
  "dispute:mediate",
  "placement:manage",
  "payout:settle",
  // Shared
  "analytics:view",
  "message:send",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Side = "buyer" | "supplier" | "platform";

/**
 * The permission matrix, spelled out role by role (not derived from a
 * compact table) so reviewers can read the grant list directly and the unit
 * test can assert the full surface cell by cell.
 *
 * - Buyer orgs: OWNER and ADMIN run the workspace; BUYER searches, sources,
 *   and orders; APPROVER gates orders over spend limits (spec: "APPROVER
 *   gates orders over spend limits") and sees analytics, but does not source.
 * - Supplier orgs: sales owns pricing (listings, quotes), ops owns
 *   fulfillment and the profile's operational data (plants, certifications,
 *   equipment); both can run the onboarding wizard.
 * - Platform: Aekovera staff run verification, moderation, disputes, and
 *   placement/commission settings.
 */
export const PERMISSION_MATRIX: Record<Role, readonly Permission[]> = {
  OWNER: [
    "catalog:search",
    "workspace:manage",
    "rfq:create",
    "rfq:manage",
    "cart:manage",
    "order:create",
    "order:approve",
    "sample:order",
    "analytics:view",
    "message:send",
  ],
  ADMIN: [
    "catalog:search",
    "workspace:manage",
    "rfq:create",
    "rfq:manage",
    "cart:manage",
    "order:create",
    "order:approve",
    "sample:order",
    "analytics:view",
    "message:send",
  ],
  BUYER: [
    "catalog:search",
    "workspace:manage",
    "rfq:create",
    "rfq:manage",
    "cart:manage",
    "order:create",
    "sample:order",
    "message:send",
  ],
  APPROVER: ["catalog:search", "order:approve", "analytics:view", "message:send"],
  SUPPLIER_SALES: [
    "supplier:onboard",
    "profile:manage",
    "listing:manage",
    "quote:create",
    "analytics:view",
    "message:send",
  ],
  SUPPLIER_OPS: [
    "supplier:onboard",
    "profile:manage",
    "shipment:manage",
    "analytics:view",
    "message:send",
  ],
  AEKOVERA_STAFF: [
    "supplier:verify",
    "moderation:manage",
    "dispute:mediate",
    "placement:manage",
    "payout:settle",
    "analytics:view",
    "message:send",
  ],
};

/** Raised when a membership's role lacks the permission an action requires. */
export class PermissionDeniedError extends Error {
  constructor(
    readonly role: Role,
    readonly permission: Permission,
  ) {
    super(`role ${role} is not granted "${permission}"`);
    this.name = "PermissionDeniedError";
  }
}

/** Every permission granted to `role`, in definition order. */
export function permissionsFor(role: Role): readonly Permission[] {
  const granted = PERMISSION_MATRIX[role];
  return PERMISSIONS.filter((p) => granted.includes(p));
}

/** Pure check: may `role` perform `permission`? */
export function can(role: Role, permission: Permission): boolean {
  return PERMISSION_MATRIX[role].includes(permission);
}

/** Throwing flavor of {@link can} — the gate every mutation calls first. */
export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new PermissionDeniedError(role, permission);
  }
}

/** Which side of the marketplace a role lives on; drives UI and scoping. */
export function roleSide(role: Role): Side {
  switch (role) {
    case "OWNER":
    case "ADMIN":
    case "BUYER":
    case "APPROVER":
      return "buyer";
    case "SUPPLIER_SALES":
    case "SUPPLIER_OPS":
      return "supplier";
    case "AEKOVERA_STAFF":
      return "platform";
  }
}
