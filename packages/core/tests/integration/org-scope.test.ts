import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import { onboardingProgress } from "../../src/onboarding";
import {
  OrgScopedRepository,
  OnboardingIncompleteError,
  PermissionDeniedError,
  ProfileSubmittedError,
  RecordNotFoundError,
  type AuthContext,
} from "../../src/index";

/**
 * Org-scoping and wizard persistence: applies the committed migrations to a
 * fresh database (self-sufficient in CI), then drives two supplier
 * organizations through the permission-gated repository to prove that
 *
 *  1. no repository function returns another org's rows,
 *  2. cross-org mutations are impossible even with a known foreign id,
 *  3. every mutation names a permission and fails closed,
 *  4. wizard progress persists across repository instances ("sessions") —
 *     a supplier who leaves after step 3 resumes at step 4,
 *  5. nothing is publicly visible until submitted for review, and the
 *     staff queue only opens to AEKOVERA_STAFF.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

let userA!: { id: string };
let userB!: { id: string };
let userC!: { id: string };
let staffUser!: { id: string };
let orgA!: { id: string };
let orgB!: { id: string };
let orgC!: { id: string };
let platformOrg!: { id: string };

function repoFor(auth: AuthContext): OrgScopedRepository {
  return new OrgScopedRepository(prisma, auth);
}

async function supplierOrg(
  slug: string,
  name: string,
  userId: string,
  role: "SUPPLIER_SALES" | "SUPPLIER_OPS",
  options: { withProfile: boolean } = { withProfile: true },
) {
  return prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name,
      slug,
      members: { create: { userId, role } },
      supplierProfile: options.withProfile ? { create: {} } : undefined,
    },
  });
}

// Migrations live in @packsource/db — run its prisma CLI there.
const dbPkgRoot = path.resolve(pkgRoot, "../db");

beforeAll(() => {
  // CI's service container starts empty — apply the committed migrations here.
  execSync("npx prisma migrate deploy", {
    cwd: dbPkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return prisma.$executeRawUnsafe(`TRUNCATE TABLE "Organization", "User", "AuditLog" CASCADE`);
}, 30_000);

beforeAll(async () => {
  userA = await prisma.user.create({ data: { email: "a@acme-int.test" } });
  userB = await prisma.user.create({ data: { email: "b@vista-int.test" } });
  userC = await prisma.user.create({ data: { email: "c@harbor-int.test" } });
  staffUser = await prisma.user.create({ data: { email: "staff@aekovera-int.test" } });
  platformOrg = await prisma.organization.create({
    data: {
      type: "PLATFORM",
      name: "Aekovera (integration)",
      slug: "aekovera-int",
      members: { create: { userId: staffUser.id, role: "AEKOVERA_STAFF" } },
    },
  });
  orgA = await supplierOrg("acme-bottling-int", "Acme Bottling Co (integration)", userA.id, "SUPPLIER_SALES");
  orgB = await supplierOrg("vista-filling-int", "Vista Filling (integration)", userB.id, "SUPPLIER_OPS");
  // orgC has no profile yet — the wizard-resumability suite drives the whole
  // flow, including the profile's creation, on a clean org.
  orgC = await supplierOrg("harbor-pack-int", "Harbor Pack (integration)", userC.id, "SUPPLIER_SALES", {
    withProfile: false,
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("org scoping", () => {
  it("reads return only the acting org's rows", async () => {
    const repoA = repoFor({ userId: userA.id, orgId: orgA.id, role: "SUPPLIER_SALES" });
    const repoB = repoFor({ userId: userB.id, orgId: orgB.id, role: "SUPPLIER_OPS" });

    const plantA = await repoA.upsertPlant({ name: "Plant One", city: "Portland", country: "US" });
    await repoB.upsertPlant({ name: "Plant Two", city: "Austin", country: "US" });

    const seenByA = await repoA.plants();
    const seenByB = await repoB.plants();

    expect(seenByA.map((p) => p.id)).toEqual([plantA.id]);
    expect(seenByA.map((p) => p.name)).toEqual(["Plant One"]);
    expect(seenByB.map((p) => p.name)).toEqual(["Plant Two"]);
  });

  it("cannot mutate another org's row even with its id", async () => {
    const repoA = repoFor({ userId: userA.id, orgId: orgA.id, role: "SUPPLIER_SALES" });
    const repoB = repoFor({ userId: userB.id, orgId: orgB.id, role: "SUPPLIER_OPS" });
    const plantB = await repoB.upsertPlant({ name: "B Plant", city: "Austin", country: "US" });

    await expect(
      repoA.upsertPlant({ id: plantB.id, name: "Hijacked", city: "Nowhere", country: "US" }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(repoA.removePlant(plantB.id)).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(repoA.removeCertification(plantB.id)).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("mutations fail closed without the required permission", async () => {
    // A buyer-role membership cannot touch supplier profile data.
    const buyerUser = await prisma.user.create({ data: { email: "buyer@brand-int.test" } });
    const buyerOrg = await prisma.organization.create({
      data: {
        type: "BUYER",
        name: "Brand Co (integration)",
        slug: "brand-co-int",
        members: { create: { userId: buyerUser.id, role: "BUYER" } },
      },
    });
    const repoBuyer = repoFor({ userId: buyerUser.id, orgId: buyerOrg.id, role: "BUYER" });

    await expect(repoBuyer.upsertPlant({ name: "X", city: "Y", country: "US" })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(repoBuyer.ensureSupplierProfile()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      repoBuyer.linkStripeConnectAccount({ accountId: "acct_x", chargesEnabled: true }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("staff reads of the review queue are gated to AEKOVERA_STAFF", async () => {
    const staffRepo = repoFor({ userId: staffUser.id, orgId: platformOrg.id, role: "AEKOVERA_STAFF" });
    const repoA = repoFor({ userId: userA.id, orgId: orgA.id, role: "SUPPLIER_SALES" });

    await expect(repoA.submittedProfilesForReview()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(staffRepo.submittedProfilesForReview()).resolves.toBeDefined();
  });
});

describe("wizard resumability (integration)", () => {
  it("persists progress across sessions — leave after step 3, resume at step 4", async () => {
    // Session 1: company, plants, certifications — then the supplier leaves.
    const session1 = repoFor({ userId: userC.id, orgId: orgC.id, role: "SUPPLIER_SALES" });
    await session1.updateCompanyDetails({ about: "Rigid glass and PET bottles for beverage brands." });
    await session1.upsertPlant({ name: "Plant One", city: "Portland", country: "US", isPrimary: true });
    await session1.upsertCertification({
      type: "SQF",
      number: "SQF-12345",
      expiresAt: new Date("2027-06-30"),
      evidenceFileId: "certifications/acme/sqf-12345.pdf",
    });

    // Session 2 — a brand-new repository instance (fresh process semantics).
    const session2 = repoFor({ userId: userC.id, orgId: orgC.id, role: "SUPPLIER_SALES" });
    const resumed = await session2.snapshot();
    expect(resumed.counts).toEqual({ plants: 1, certifications: 1, equipment: 0, capabilities: 0 });

    const progressAfter3 = onboardingProgress(resumed);
    expect(progressAfter3.firstIncomplete).toBe("equipment");

    // Session 2 finishes equipment, terms, and the Stripe link.
    await session2.upsertEquipment({ kind: "FILLER", make: "Krones", specs: { speedUnitsPerHour: 24000 } });
    await session2.addCapability({ name: "hot-fill" });
    await session2.updateCommercialTerms({ minOrderValueCents: 250000, paymentTerms: "NET_30" });
    await session2.linkStripeConnectAccount({ accountId: "acct_mock_000001", chargesEnabled: true });

    const complete = onboardingProgress(await session2.snapshot());
    expect(complete.isComplete).toBe(true);
    expect(complete.isSubmitted).toBe(false);

    // Submission is blocked until every step is done — proven on org B,
    // which never completed the wizard.
    const sessionB = repoFor({ userId: userB.id, orgId: orgB.id, role: "SUPPLIER_OPS" });
    await expect(sessionB.submitForReview(new Date())).rejects.toBeInstanceOf(OnboardingIncompleteError);

    // Session 3 submits; the profile then locks and turns publicly visible.
    const session3 = repoFor({ userId: userC.id, orgId: orgC.id, role: "SUPPLIER_SALES" });
    const submitted = await session3.submitForReview(new Date("2026-09-17T00:00:00Z"));
    expect(submitted.profile.submittedForReviewAt).toEqual(new Date("2026-09-17T00:00:00Z"));

    await expect(session3.updateCompanyDetails({ about: "post-submit edit" })).rejects.toBeInstanceOf(
      ProfileSubmittedError,
    );
    await expect(session3.upsertPlant({ name: "Late", city: "X", country: "US" })).rejects.toBeInstanceOf(
      ProfileSubmittedError,
    );
  });

  it("publishes nothing until submitted, and the staff queue sees submissions", async () => {
    const anonymous = repoFor({ userId: userB.id, orgId: orgB.id, role: "SUPPLIER_OPS" });
    const staffRepo = repoFor({ userId: staffUser.id, orgId: platformOrg.id, role: "AEKOVERA_STAFF" });

    // Org B is still a draft — invisible to the marketplace surface and
    // absent from the review queue, which lists org C (submitted above).
    expect(await anonymous.publicSupplierProfile(orgB.id)).toBeNull();
    const queue = await staffRepo.submittedProfilesForReview();
    expect(queue.map((p) => p.orgId)).toContain(orgC.id);
    expect(queue.map((p) => p.orgId)).not.toContain(orgB.id);

    // Org C submitted in the previous test: publicly visible.
    const publicC = await anonymous.publicSupplierProfile(orgC.id);
    expect(publicC).not.toBeNull();
    expect(publicC?.stripeConnectAccountId).toBe("acct_mock_000001");
  });

  it("writes an append-only audit row for each mutation", async () => {
    const logs = await prisma.auditLog.findMany({
      where: { orgId: orgC.id },
      orderBy: { createdAt: "asc" },
    });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("supplier.profile.create");
    expect(actions).toContain("supplier.profile.update_company");
    expect(actions).toContain("supplier.plant.upsert");
    expect(actions).toContain("supplier.certification.create");
    expect(actions).toContain("supplier.equipment.upsert");
    expect(actions).toContain("supplier.capability.upsert");
    expect(actions).toContain("supplier.profile.update_terms");
    expect(actions).toContain("supplier.profile.link_stripe");
    expect(actions).toContain("supplier.profile.submit_for_review");
    // Every audit row is attributed to the acting user.
    for (const log of logs) {
      expect(log.actorUserId).toBe(userC.id);
      expect(log.actorType).toBe("user");
    }
  });
});
