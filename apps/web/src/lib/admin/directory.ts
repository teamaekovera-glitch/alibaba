/**
 * Basic org/user administration (spec: administration — "Basic org/user
 * administration (add/remove members, role changes)"). Read helpers feed the
 * console directory; the mutating ops gate on `admin:access` and write
 * audit rows.
 */
import { Prisma, type PrismaClient } from "@packsource/db";
import { ROLES, RecordNotFoundError, assertCan, type AuthContext, type Role } from "@packsource/core";
import type { NotificationEngine } from "@packsource/notifications";
import { db } from "@/lib/db";

export const DIRECTORY_AUDIT = {
  membershipRoleChange: "org.membership.role_changed",
  membershipRemove: "org.membership.removed",
} as const;

/** All orgs with members, member counts, and verification state — staff-only read. */
export async function adminOrganizations(auth: AuthContext, search?: string) {
  assertCan(auth.role, "admin:access");
  return db.organization.findMany({
    where: {
      deletedAt: null,
      ...(search?.trim() ? { name: { contains: search.trim(), mode: "insensitive" as const } } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: {
      members: {
        orderBy: [{ role: "asc" as const }, { userId: "asc" }],
        include: { user: { select: { id: true, email: true, name: true, deletedAt: true } } },
      },
      _count: { select: { members: true } },
      supplierProfile: { select: { id: true, verificationStatus: true } },
    },
  });
}

/** One org with its members and supplier profile — staff-only read. */
export async function adminOrganizationDetail(auth: AuthContext, orgId: string) {
  assertCan(auth.role, "admin:access");
  const org = await db.organization.findFirst({
    where: { id: orgId, deletedAt: null },
    include: {
      members: {
        orderBy: [{ role: "asc" as const }, { userId: "asc" }],
        include: { user: { select: { id: true, email: true, name: true, deletedAt: true } } },
      },
      supplierProfile: {
        select: { id: true, verificationStatus: true, verifiedAt: true, submittedForReviewAt: true },
      },
    },
  });
  if (!org) {
    throw new RecordNotFoundError("Organization", orgId);
  }
  return org;
}

/** Users with their memberships — staff-only read. */
export async function adminUsers(auth: AuthContext, search?: string) {
  assertCan(auth.role, "admin:access");
  return db.user.findMany({
    where: {
      deletedAt: null,
      ...(search?.trim()
        ? {
            OR: [
              { email: { contains: search.trim(), mode: "insensitive" as const } },
              { name: { contains: search.trim(), mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ email: "asc" }, { id: "asc" }],
    include: { memberships: { include: { org: { select: { id: true, name: true } } } } },
  });
}

export interface SetMemberRoleInput {
  membershipId: string;
  role: Role;
  now: Date;
}

export interface SetMemberRoleResult {
  membershipId: string;
  userId: string;
  orgId: string;
  from: Role;
  to: Role;
  notificationIds: string[];
  emailIds: string[];
}

/**
 * Change a membership's role (admin:access). Audited on the membership's
 * org; the affected user is notified. Role values are validated against the
 * ROLES list — an unknown role is a 400-class error, not a silent write.
 */
export async function setMemberRole(
  database: PrismaClient,
  auth: AuthContext,
  notifications: NotificationEngine,
  input: SetMemberRoleInput,
): Promise<SetMemberRoleResult> {
  assertCan(auth.role, "admin:access");
  if (!assignableRoles().includes(input.role)) {
    throw new Error(`role ${input.role} is not assignable from the admin console`);
  }

  return database.$transaction(async (tx) => {
    const membership = await tx.orgMembership.findUnique({
      where: { id: input.membershipId },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!membership) {
      throw new RecordNotFoundError("OrgMembership", input.membershipId);
    }
    if (membership.role === input.role) {
      throw new Error(`membership ${membership.id} already has role ${input.role}`);
    }

    await tx.orgMembership.update({
      where: { id: membership.id },
      data: { role: input.role },
    });

    await tx.auditLog.create({
      data: {
        orgId: membership.orgId,
        actorUserId: auth.userId,
        actorType: "user",
        action: DIRECTORY_AUDIT.membershipRoleChange,
        entityType: "OrgMembership",
        entityId: membership.id,
        before: { role: membership.role } as Prisma.InputJsonValue,
        after: { role: input.role } as Prisma.InputJsonValue,
      },
    });

    const sent = await notifications.notify({
      orgId: membership.orgId,
      userIds: [membership.userId],
      kind: "ORG_ROLE_CHANGED",
      title: `Your role changed to ${input.role}`,
      body: `Aekovera staff updated your role to ${input.role}.`,
      linkUrl: "/",
      entityType: "OrgMembership",
      entityId: membership.id,
      now: input.now,
    });

    return {
      membershipId: membership.id,
      userId: membership.userId,
      orgId: membership.orgId,
      from: membership.role as Role,
      to: input.role,
      notificationIds: sent.notificationIds,
      emailIds: sent.emails.map((email) => email.emailId),
    };
  });
}

export interface RemoveMemberInput {
  membershipId: string;
  now: Date;
}

/**
 * Remove a member from an org by deleting the membership row (admin:access).
 * Audited on the org; the removed user keeps their account but loses org
 * scoping for future sessions (orgId resolves from memberships).
 */
export async function removeMember(
  database: PrismaClient,
  auth: AuthContext,
  input: RemoveMemberInput,
): Promise<{ membershipId: string; userId: string; orgId: string }> {
  assertCan(auth.role, "admin:access");

  return database.$transaction(async (tx) => {
    const membership = await tx.orgMembership.findUnique({
      where: { id: input.membershipId },
    });
    if (!membership) {
      throw new RecordNotFoundError("OrgMembership", input.membershipId);
    }
    await tx.orgMembership.delete({ where: { id: membership.id } });
    await tx.auditLog.create({
      data: {
        orgId: membership.orgId,
        actorUserId: auth.userId,
        actorType: "user",
        action: DIRECTORY_AUDIT.membershipRemove,
        entityType: "OrgMembership",
        entityId: membership.id,
        before: { role: membership.role, userId: membership.userId } as Prisma.InputJsonValue,
        after: { removed: true } as Prisma.InputJsonValue,
      },
    });
    return { membershipId: membership.id, userId: membership.userId, orgId: membership.orgId };
  });
}

/** Every assignable role except the staff role itself — no self-promotion. */
export function assignableRoles(): readonly Role[] {
  return ROLES.filter((role) => role !== "AEKOVERA_STAFF");
}
