/**
 * Permission-gated, org-scoped repository functions (spec: "Multi-tenancy
 * and roles"). Every query is pinned to the acting membership's orgId, so no
 * function can return another org's rows; every mutation names the
 * permission it requires and fails closed.
 *
 * The Prisma client is injected (the caller owns the connection); this module
 * only needs its types. Once a supplier profile is submitted for review its
 * wizard-owned fields lock — edits move to the staff verification flow.
 */
import type { EquipmentKind, PaymentTerms, Prisma, PrismaClient } from "@packsource/db";
import { assertCan, type Permission, type Role } from "./permissions";
import { isPubliclyVisible, onboardingProgress, type OnboardingProgress } from "./onboarding";

/** The generated Prisma client or any transaction handle it can produce. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/** Who is acting. The whole security model hangs off these three fields. */
export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
}

export class RecordNotFoundError extends Error {
  constructor(entity: string, criteria: string) {
    super(`${entity} not found for this organization: ${criteria}`);
    this.name = "RecordNotFoundError";
  }
}

/** Raised on wizard-owned edits after the profile was submitted for review. */
export class ProfileSubmittedError extends Error {
  constructor() {
    super("profile already submitted for review — edits are locked");
    this.name = "ProfileSubmittedError";
  }
}

/** Raised by submitForReview when any wizard step is still incomplete. */
export class OnboardingIncompleteError extends Error {
  constructor(readonly firstIncompleteStep: string) {
    super(`onboarding incomplete — next step: ${firstIncompleteStep}`);
    this.name = "OnboardingIncompleteError";
  }
}

export interface PlantInput {
  id?: string; // present → update that (owned) row
  name: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city: string;
  state?: string | null;
  postalCode?: string | null;
  country: string;
  isPrimary?: boolean;
}

export interface CertificationInput {
  id?: string;
  type: string;
  number: string;
  issuedAt?: Date | null;
  expiresAt: Date;
  /** R2 object key from the Storage adapter; null while mock-first. */
  evidenceFileId?: string | null;
}

export interface EquipmentInput {
  kind: EquipmentKind;
  make?: string | null;
  model?: string | null;
  specs: Prisma.InputJsonValue;
}

export interface CapabilityInput {
  name: string;
  detail?: string | null;
}

export interface CompanyDetailsInput {
  about: string;
  billingEmail?: string | null;
}

export interface CommercialTermsInput {
  minOrderValueCents: number;
  paymentTerms: PaymentTerms;
}

/** Audit-log actions written by this repository (append-only table). */
const AUDIT = {
  profileCreate: "supplier.profile.create",
  profileUpdate: "supplier.profile.update_company",
  termsUpdate: "supplier.profile.update_terms",
  stripeLink: "supplier.profile.link_stripe",
  submit: "supplier.profile.submit_for_review",
  plantUpsert: "supplier.plant.upsert",
  plantDelete: "supplier.plant.delete",
  certificationCreate: "supplier.certification.create",
  certificationDelete: "supplier.certification.delete",
  equipmentUpsert: "supplier.equipment.upsert",
  equipmentDelete: "supplier.equipment.delete",
  capabilityUpsert: "supplier.capability.upsert",
  capabilityDelete: "supplier.capability.delete",
} as const;

export class OrgScopedRepository {
  readonly #db: PrismaClient;
  readonly #auth: AuthContext;

  constructor(db: PrismaClient, auth: AuthContext) {
    this.#db = db;
    this.#auth = auth;
  }

  /** Fail-closed gate — every mutation names the permission it needs. */
  #require(permission: Permission): void {
    assertCan(this.#auth.role, permission);
  }

  /** Append-only audit row, written inside the caller's transaction. */
  async #audit(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId: this.#auth.orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType,
        entityId,
      },
    });
  }

  // ── reads (org-scoped; safe for any member of the org) ───────────────────

  /** The acting membership's organization. */
  async organization() {
    return this.#db.organization.findFirst({
      where: { id: this.#auth.orgId, deletedAt: null },
    });
  }

  /** This org's supplier profile, or null when onboarding never started. */
  async supplierProfile() {
    return this.#db.supplierProfile.findUnique({ where: { orgId: this.#auth.orgId } });
  }

  async plants() {
    return this.#db.plant.findMany({ where: { orgId: this.#auth.orgId }, orderBy: { createdAt: "asc" } });
  }

  async certifications() {
    return this.#db.certification.findMany({
      where: { orgId: this.#auth.orgId },
      orderBy: { createdAt: "asc" },
    });
  }

  async equipment() {
    return this.#db.equipment.findMany({ where: { orgId: this.#auth.orgId }, orderBy: { createdAt: "asc" } });
  }

  async capabilities() {
    return this.#db.capability.findMany({ where: { orgId: this.#auth.orgId }, orderBy: { createdAt: "asc" } });
  }

  /** Everything the pure onboarding rules need, in one org-scoped read. */
  async snapshot() {
    const [org, profile, plants, certifications, equipment, capabilities] = await Promise.all([
      this.organization(),
      this.supplierProfile(),
      this.plants(),
      this.certifications(),
      this.equipment(),
      this.capabilities(),
    ]);
    return {
      org: { name: org?.name ?? "" },
      profile,
      counts: {
        plants: plants.length,
        certifications: certifications.length,
        equipment: equipment.length,
        capabilities: capabilities.length,
      },
    };
  }

  // ── public marketplace surface ────────────────────────────────────────────

  /**
   * Anonymous-readable supplier profile. Consults the publishing gate: a
   * profile that has not been submitted for review simply does not exist
   * outside its own org and the staff verification queue.
   */
  async publicSupplierProfile(orgId: string) {
    const profile = await this.#db.supplierProfile.findFirst({
      where: { orgId, submittedForReviewAt: { not: null } },
    });
    if (!profile || !isPubliclyVisible(profile)) {
      return null;
    }
    return profile;
  }

  // ── staff verification queue ──────────────────────────────────────────────

  /** Profiles awaiting review — staff-only, explicitly cross-org by design. */
  async submittedProfilesForReview() {
    this.#require("supplier:verify");
    return this.#db.supplierProfile.findMany({
      where: { submittedForReviewAt: { not: null }, verifiedAt: null },
      orderBy: { submittedForReviewAt: "asc" },
    });
  }

  // ── wizard mutations (permission-gated, audited, locked after submit) ────

  /** Idempotently create this org's profile (wizard entry point). */
  async ensureSupplierProfile() {
    this.#require("supplier:onboard");
    return this.#db.$transaction((tx) => this.#ensureProfileIn(tx));
  }

  /** Step 1 — company details. */
  async updateCompanyDetails(input: CompanyDetailsInput) {
    this.#require("supplier:onboard");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const org = await tx.organization.findFirst({ where: { id: this.#auth.orgId } });
      if (!org) {
        throw new RecordNotFoundError("Organization", this.#auth.orgId);
      }
      await tx.organization.update({
        where: { id: org.id },
        data: { billingEmail: input.billingEmail ?? org.billingEmail },
      });
      const profile = await this.#ensureProfileIn(tx);
      const updated = await tx.supplierProfile.update({
        where: { id: profile.id },
        data: { about: input.about },
      });
      await this.#audit(tx, AUDIT.profileUpdate, "SupplierProfile", profile.id);
      return updated;
    });
  }

  /** Step 2 — add a plant, or update one this org already owns. */
  async upsertPlant(input: PlantInput) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const profile = await this.#ensureProfileIn(tx);
      if (input.isPrimary) {
        await tx.plant.updateMany({
          where: { orgId: this.#auth.orgId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      const data = {
        name: input.name,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city,
        state: input.state ?? null,
        postalCode: input.postalCode ?? null,
        country: input.country,
        isPrimary: input.isPrimary ?? false,
      };
      if (input.id !== undefined) {
        const owned = await tx.plant.findFirst({
          where: { id: input.id, orgId: this.#auth.orgId },
        });
        if (!owned) {
          throw new RecordNotFoundError("Plant", input.id);
        }
        const updated = await tx.plant.update({ where: { id: owned.id }, data });
        await this.#audit(tx, AUDIT.plantUpsert, "Plant", owned.id);
        return updated;
      }
      const created = await tx.plant.create({
        data: {
          ...data,
          orgId: this.#auth.orgId,
          supplierProfileId: profile.id,
        },
      });
      await this.#audit(tx, AUDIT.plantUpsert, "Plant", created.id);
      return created;
    });
  }

  async removePlant(plantId: string) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const owned = await tx.plant.findFirst({
        where: { id: plantId, orgId: this.#auth.orgId },
      });
      if (!owned) {
        throw new RecordNotFoundError("Plant", plantId);
      }
      await tx.plant.delete({ where: { id: owned.id } });
      await this.#audit(tx, AUDIT.plantDelete, "Plant", owned.id);
    });
  }

  /** Step 3 — certifications (with the Storage adapter's object key). */
  async upsertCertification(input: CertificationInput) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const profile = await this.#ensureProfileIn(tx);
      const data = {
        type: input.type,
        number: input.number,
        issuedAt: input.issuedAt ?? null,
        expiresAt: input.expiresAt,
        evidenceFileId: input.evidenceFileId ?? null,
      };
      if (input.id !== undefined) {
        const owned = await tx.certification.findFirst({
          where: { id: input.id, orgId: this.#auth.orgId },
        });
        if (!owned) {
          throw new RecordNotFoundError("Certification", input.id);
        }
        const updated = await tx.certification.update({ where: { id: owned.id }, data });
        await this.#audit(tx, AUDIT.certificationCreate, "Certification", owned.id);
        return updated;
      }
      const created = await tx.certification.create({
        data: { ...data, orgId: this.#auth.orgId, supplierProfileId: profile.id },
      });
      await this.#audit(tx, AUDIT.certificationCreate, "Certification", created.id);
      return created;
    });
  }

  async removeCertification(certificationId: string) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const owned = await tx.certification.findFirst({
        where: { id: certificationId, orgId: this.#auth.orgId },
      });
      if (!owned) {
        throw new RecordNotFoundError("Certification", certificationId);
      }
      await tx.certification.delete({ where: { id: owned.id } });
      await this.#audit(tx, AUDIT.certificationDelete, "Certification", owned.id);
    });
  }

  /** Step 4 — equipment and capabilities. */
  async upsertEquipment(input: EquipmentInput) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const profile = await this.#ensureProfileIn(tx);
      const created = await tx.equipment.create({
        data: {
          kind: input.kind,
          make: input.make ?? null,
          model: input.model ?? null,
          specs: input.specs,
          orgId: this.#auth.orgId,
          supplierProfileId: profile.id,
        },
      });
      await this.#audit(tx, AUDIT.equipmentUpsert, "Equipment", created.id);
      return created;
    });
  }

  async removeEquipment(equipmentId: string) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const owned = await tx.equipment.findFirst({
        where: { id: equipmentId, orgId: this.#auth.orgId },
      });
      if (!owned) {
        throw new RecordNotFoundError("Equipment", equipmentId);
      }
      await tx.equipment.delete({ where: { id: owned.id } });
      await this.#audit(tx, AUDIT.equipmentDelete, "Equipment", owned.id);
    });
  }

  async addCapability(input: CapabilityInput) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const profile = await this.#ensureProfileIn(tx);
      const created = await tx.capability.upsert({
        where: { supplierProfileId_name: { supplierProfileId: profile.id, name: input.name } },
        create: {
          name: input.name,
          detail: input.detail ?? null,
          orgId: this.#auth.orgId,
          supplierProfileId: profile.id,
        },
        update: { detail: input.detail ?? null },
      });
      await this.#audit(tx, AUDIT.capabilityUpsert, "Capability", created.id);
      return created;
    });
  }

  async removeCapability(capabilityId: string) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const owned = await tx.capability.findFirst({
        where: { id: capabilityId, orgId: this.#auth.orgId },
      });
      if (!owned) {
        throw new RecordNotFoundError("Capability", capabilityId);
      }
      await tx.capability.delete({ where: { id: owned.id } });
      await this.#audit(tx, AUDIT.capabilityDelete, "Capability", owned.id);
    });
  }

  /** Step 5 — MOQ and payment terms. */
  async updateCommercialTerms(input: CommercialTermsInput) {
    this.#require("profile:manage");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const profile = await this.#ensureProfileIn(tx);
      const updated = await tx.supplierProfile.update({
        where: { id: profile.id },
        data: { minOrderValueCents: input.minOrderValueCents, paymentTerms: input.paymentTerms },
      });
      await this.#audit(tx, AUDIT.termsUpdate, "SupplierProfile", profile.id);
      return updated;
    });
  }

  /** Step 6 — persist the Payments adapter's connected-account id. */
  async linkStripeConnectAccount(account: { accountId: string; chargesEnabled: boolean }) {
    this.#require("supplier:onboard");
    return this.#db.$transaction(async (tx) => {
      await this.#assertNotSubmitted(tx);
      const profile = await this.#ensureProfileIn(tx);
      const updated = await tx.supplierProfile.update({
        where: { id: profile.id },
        data: {
          stripeConnectAccountId: account.accountId,
          stripeChargesEnabled: account.chargesEnabled,
        },
      });
      await this.#audit(tx, AUDIT.stripeLink, "SupplierProfile", profile.id);
      return updated;
    });
  }

  /**
   * Hand the profile to the review queue. Only a fully-complete wizard can
   * submit; afterwards the wizard-owned fields lock. Returns the updated
   * profile with submittedForReviewAt set.
   */
  async submitForReview(submittedAt: Date): Promise<OnboardingSubmitResult> {
    this.#require("supplier:onboard");
    return this.#db.$transaction(async (tx) => {
      const snapshot = await this.snapshotIn(tx);
      const profile = snapshot.profile;
      if (!profile) {
        throw new RecordNotFoundError("SupplierProfile", this.#auth.orgId);
      }
      const progress = onboardingProgress(snapshot);
      if (!progress.isComplete) {
        throw new OnboardingIncompleteError(progress.firstIncomplete ?? "unknown");
      }
      if (profile.submittedForReviewAt !== null) {
        throw new ProfileSubmittedError();
      }
      const updated = await tx.supplierProfile.update({
        where: { id: profile.id },
        data: { submittedForReviewAt: submittedAt },
      });
      await this.#audit(tx, AUDIT.submit, "SupplierProfile", profile.id);
      return { profile: updated, progress: onboardingProgress({ ...snapshot, profile: updated }) };
    });
  }

  // ── transaction-internal helpers ──────────────────────────────────────────

  async #assertNotSubmitted(tx: Prisma.TransactionClient): Promise<void> {
    const profile = await tx.supplierProfile.findUnique({ where: { orgId: this.#auth.orgId } });
    if (profile?.submittedForReviewAt) {
      throw new ProfileSubmittedError();
    }
  }

  /** Idempotently fetch (or lazily create) this org's profile, auditing creation. */
  async #ensureProfileIn(tx: Prisma.TransactionClient) {
    const existing = await tx.supplierProfile.findUnique({ where: { orgId: this.#auth.orgId } });
    if (existing) {
      return existing;
    }
    const profile = await tx.supplierProfile.create({ data: { orgId: this.#auth.orgId } });
    await this.#audit(tx, AUDIT.profileCreate, "SupplierProfile", profile.id);
    return profile;
  }

  async snapshotIn(tx: Prisma.TransactionClient) {
    const [org, profile, plants, certifications, equipment, capabilities] = await Promise.all([
      tx.organization.findFirst({ where: { id: this.#auth.orgId, deletedAt: null } }),
      tx.supplierProfile.findUnique({ where: { orgId: this.#auth.orgId } }),
      tx.plant.findMany({ where: { orgId: this.#auth.orgId } }),
      tx.certification.findMany({ where: { orgId: this.#auth.orgId } }),
      tx.equipment.findMany({ where: { orgId: this.#auth.orgId } }),
      tx.capability.findMany({ where: { orgId: this.#auth.orgId } }),
    ]);
    return {
      org: { name: org?.name ?? "" },
      profile,
      counts: {
        plants: plants.length,
        certifications: certifications.length,
        equipment: equipment.length,
        capabilities: capabilities.length,
      },
    };
  }
}

export interface OnboardingSubmitResult {
  profile: Awaited<ReturnType<PrismaClient["supplierProfile"]["update"]>>;
  progress: OnboardingProgress;
}
