/**
 * Organization verification management (spec: administration — staff adjust a
 * supplier's verification tier; every change audited). Verification is
 * required before listings go live, so tier changes notify the supplier org's
 * owners/admins immediately (in-app + mock email).
 */
import { Prisma, type PrismaClient, type VerificationStatus } from "@packsource/db";
import { RecordNotFoundError, assertCan, type AuthContext } from "@packsource/core";
import type { NotificationEngine } from "@packsource/notifications";
import { db } from "@/lib/db";

export const VERIFICATION_AUDIT = {
  change: "supplier.verify",
} as const;

/** No-op tier change — the current tier already matches. */
export class VerificationStateError extends Error {
  constructor(orgId: string, tier: string) {
    super(`organization ${orgId} is already ${tier}`);
    this.name = "VerificationStateError";
  }
}

export interface SetVerificationTierInput {
  orgId: string;
  /** The schema's verification enum: UNVERIFIED | VERIFIED | AEKOVERA_VETTED. */
  tier: VerificationStatus;
  note?: string;
  now: Date;
}

export interface SetVerificationTierResult {
  orgId: string;
  from: string;
  to: string;
  notificationIds: string[];
  emailIds: string[];
}

/**
 * Set a supplier org's verification tier (supplier:verify). Clears
 * verifiedAt/verifiedByUserId when demoting to UNVERIFIED, mirrors the
 * onboarding wizard's submit behavior for PENDING_REVIEW, and stamps the
 * acting staff user for VERIFIED. Always audited with before/after tiers.
 */
export async function setVerificationTier(
  database: PrismaClient,
  auth: AuthContext,
  notifications: NotificationEngine,
  input: SetVerificationTierInput,
): Promise<SetVerificationTierResult> {
  assertCan(auth.role, "supplier:verify");

  return database.$transaction(async (tx) => {
    const org = await tx.organization.findFirst({
      where: { id: input.orgId, deletedAt: null },
      include: { supplierProfile: true },
    });
    if (!org) {
      throw new RecordNotFoundError("Organization", input.orgId);
    }
    if (!org.supplierProfile) {
      throw new VerificationStateError(org.id, "without a supplier profile (not a supplier org)");
    }
    if (org.supplierProfile.verificationStatus === input.tier) {
      throw new VerificationStateError(org.id, input.tier);
    }

    const demoting = input.tier === "UNVERIFIED";
    const profile = await tx.supplierProfile.update({
      where: { orgId: org.id },
      data: {
        verificationStatus: input.tier,
        verifiedAt: demoting ? null : input.now,
        verifiedByUserId: demoting ? null : auth.userId,
      },
    });

    await tx.auditLog.create({
      data: {
        orgId: org.id,
        actorUserId: auth.userId,
        actorType: "user",
        action: VERIFICATION_AUDIT.change,
        entityType: "SupplierProfile",
        entityId: profile.id,
        before: { verificationStatus: org.supplierProfile.verificationStatus } as Prisma.InputJsonValue,
        after: {
          verificationStatus: input.tier,
          note: input.note ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    // The supplier org's owners/admins are told immediately — verification
    // gates listing visibility, so silence here stalls their pipeline.
    const members = await tx.orgMembership.findMany({
      where: { orgId: org.id, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { userId: "asc" },
      select: { userId: true },
    });
    const sent =
      members.length > 0
        ? await notifications.notify({
            orgId: org.id,
            userIds: members.map((member) => member.userId),
            kind: "VERIFICATION_CHANGED",
            title: `Verification status changed to ${input.tier}`,
            body:
              input.note?.trim() ||
              `Aekovera staff set your organization's verification status to ${input.tier}.`,
            linkUrl: "/onboarding",
            entityType: "SupplierProfile",
            entityId: profile.id,
            now: input.now,
          })
        : { notificationIds: [], emails: [] };

    return {
      orgId: org.id,
      from: org.supplierProfile.verificationStatus,
      to: input.tier,
      notificationIds: sent.notificationIds,
      emailIds: sent.emails.map((email) => email.emailId),
    };
  });
}

/**
 * The verification queue: supplier orgs with profiles, oldest submission
 * first (deterministic). Staff-only read.
 */
export async function verificationQueue(auth: AuthContext) {
  assertCan(auth.role, "supplier:verify");
  return db.organization.findMany({
    where: { deletedAt: null, type: "SUPPLIER", supplierProfile: { isNot: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      _count: { select: { members: true } },
      supplierProfile: {
        select: {
          id: true,
          verificationStatus: true,
          submittedForReviewAt: true,
          verifiedAt: true,
        },
      },
    },
  });
}
