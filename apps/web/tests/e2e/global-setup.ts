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

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384 });
  return `scrypt$16384$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export default async function globalSetup(): Promise<void> {
  const repoRoot = path.join(__dirname, "../../..");
  execSync("pnpm --filter @packsource/db exec prisma migrate deploy", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set for the e2e suite");
  }
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
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
  } finally {
    await prisma.$disconnect();
  }
}
