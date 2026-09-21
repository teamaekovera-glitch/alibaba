import { execSync } from "node:child_process";
import { scryptSync, randomBytes } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@packsource/db";

/**
 * E2E global setup: apply migrations, then seed one supplier org + an
 * operations user with a password, idempotently (re-runs are no-ops).
 * Zero API keys — the scrypt hash format matches apps/web's verifyPassword.
 */

export const E2E_EMAIL = "supplier-ops@e2e.packsource.test";
export const E2E_PASSWORD = "e2e-password-123";
export const E2E_ORG_SLUG = "e2e-supplier";

/** Deterministic org ids from the fictional seed (see packages/db/src/seed). */
export const E2E_SEED_SUPPLIER_ORG_ID = "seed_org_supplier_001";
export const E2E_SEED_BUYER_ORG_ID = "seed_org_buyer_01";

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384 });
  return `scrypt$16384$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export default async function globalSetup(): Promise<void> {
  const repoRoot = path.join(__dirname, "../../..");
  // Reset to a fresh migrated schema on every run. The mock Stripe adapter
  // mints deterministic payment-intent ids, so e2e-created rows from
  // previous runs collide on unique constraints — a clean schema per run
  // makes local runs identical to CI.
  execSync("pnpm --filter @packsource/db exec prisma migrate reset --force --skip-generate", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  // Recreate the deterministic fictional data (seeded listings, orgs, and
  // workflow rows the suite reads).
  execSync("pnpm --filter @packsource/db seed", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set for the e2e suite");
  }
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // Wizard account (PR #4 spec): its own supplier org, SUPPLIER_OPS role.
    const org = await prisma.organization.upsert({
      where: { slug: E2E_ORG_SLUG },
      create: { type: "SUPPLIER", name: "E2E Supplier Co", slug: E2E_ORG_SLUG },
      update: {},
    });
    const user = await prisma.user.upsert({
      where: { email: E2E_EMAIL },
      create: { email: E2E_EMAIL, passwordHash: hashPassword(E2E_PASSWORD) },
      update: { passwordHash: hashPassword(E2E_PASSWORD) },
    });
    const existing = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
    });
    if (!existing) {
      await prisma.orgMembership.create({
        data: { orgId: org.id, userId: user.id, role: "SUPPLIER_OPS" },
      });
    }

    // Role-specific accounts for the trade/listing suites. Each user carries
    // exactly ONE membership so auth.ts's "first membership wins" resolution
    // is deterministic; org ids reference the deterministic seed (recreated
    // identically on reseed, so these memberships survive it).
    await ensureMembership(prisma, "buyer@e2e.packsource.test", E2E_SEED_BUYER_ORG_ID, "OWNER");
    await ensureMembership(prisma, "sales@e2e.packsource.test", E2E_SEED_SUPPLIER_ORG_ID, "SUPPLIER_SALES");
    await ensureMembership(prisma, "ops@e2e.packsource.test", E2E_SEED_SUPPLIER_ORG_ID, "SUPPLIER_OPS");

    // Platform staff account — exercising staff-gated surfaces (publish,
    // moderation) once the admin/trust waves merge and the suite extends.
    const staffOrg = await prisma.organization.upsert({
      where: { slug: "e2e-platform" },
      create: { type: "PLATFORM", name: "E2E Aekovera Staff", slug: "e2e-platform" },
      update: {},
    });
    await ensureMembership(prisma, "staff@e2e.packsource.test", staffOrg.id, "AEKOVERA_STAFF");
  } finally {
    await prisma.$disconnect();
  }
}

/** Create the user with a password when missing and attach exactly one role membership. */
async function ensureMembership(
  prisma: PrismaClient,
  email: string,
  orgId: string,
  role: "OWNER" | "SUPPLIER_SALES" | "SUPPLIER_OPS" | "AEKOVERA_STAFF",
): Promise<void> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash: hashPassword(E2E_PASSWORD), emailVerified: new Date() },
    update: { passwordHash: hashPassword(E2E_PASSWORD) },
  });
  const existing = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId, userId: user.id } },
  });
  if (!existing) {
    await prisma.orgMembership.create({ data: { orgId, userId: user.id, role } });
  }
}
