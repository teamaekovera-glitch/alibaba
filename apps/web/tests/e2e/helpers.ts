import type { Page } from "@playwright/test";
import { PrismaClient } from "@packsource/db";
import { RfqRepository, type AuthContext } from "@packsource/core";

/**
 * Shared e2e helpers. Zero API keys: sessions come from the password
 * credentials provider against users seeded by global-setup, and the one
 * server-side bootstrap (creating + sending an RFQ the UI cannot express
 * yet — see buyer-journey.spec.ts) runs through the same @packsource/core
 * repositories the server actions use.
 */

export const E2E_PASSWORD = "e2e-password-123";

/** Seeded/created by global-setup; org slugs and ids come from the deterministic seed. */
export const BUYER_EMAIL = "buyer@e2e.packsource.test";
export const SALES_EMAIL = "sales@e2e.packsource.test";
export const OPS_EMAIL = "ops@e2e.packsource.test";

/** Live seeded listing (verified: seed_listing_0001, seed_org_supplier_001, rigid). */
export const TARGET_LISTING_ID = "seed_listing_0001";
export const TARGET_LISTING_SLUG = "seed-listing-0001";
/** Second live seeded listing, owned by a different supplier — used by the compare flow. */
export const OTHER_LISTING_SLUG = "seed-listing-0002";

/** Fixed title so inbox/dashboard lookups are stable and reruns are idempotent-ish. */
export const JOURNEY_RFQ_TITLE = "E2E — 32oz PP Cup run";

/**
 * Sign in through the real password tab of /sign-in and wait for the app
 * shell (redirect to /). Safe to call on any page in any context.
 */
export async function signInWithPassword(page: Page, email: string, password: string = E2E_PASSWORD): Promise<void> {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Password" }).click();
  await page.getByTestId("password-email").fill(email);
  await page.getByTestId("password-field").fill(password);
  await page.getByTestId("password-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
}

/**
 * Buyer-side RFQ bootstrap: create a SINGLE-mode RFQ against a live seeded
 * listing and send it, through the exact RfqRepository the server actions
 * use. The merged UI cannot express this yet (the lean create form has no
 * category field, and BROADCAST sends match on category; SINGLE is not
 * offered) — the gap is reported in the closing PR, not patched around in
 * app code. Returns the rfq id for UI navigation.
 */
export async function bootstrapSentRfq(input: {
  buyerEmail: string;
  buyerOrgId: string;
  listingId: string;
  title: string;
  quantity: number;
}): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set for the e2e bootstrap");
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const user = await prisma.user.findUnique({ where: { email: input.buyerEmail } });
    if (!user) {
      throw new Error(`e2e buyer user ${input.buyerEmail} is missing — run global-setup`);
    }
    const authContext: AuthContext = {
      userId: user.id,
      orgId: input.buyerOrgId,
      role: "OWNER",
    };
    const rfqRepository = new RfqRepository(prisma, authContext);
    const existing = await prisma.rfq.findFirst({
      where: { orgId: input.buyerOrgId, title: input.title },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      // Reuse when a previous run left this RFQ in a reusable state; a fresh
      // run after a completed journey creates a new one (the old one is past
      // DRAFT and cannot be resent).
      return existing.id;
    }
    const rfq = await rfqRepository.create({
      mode: "SINGLE",
      title: input.title,
      listingId: input.listingId,
      quantity: input.quantity,
      lines: [{ description: input.title, quantity: input.quantity }],
      // The RFQ spec contract version lives inside the spec envelope
      // (rfqSpecSchema pins `version: z.literal(1)`).
      spec: { version: 1 },
    });
    await rfqRepository.send(rfq.id);
    return rfq.id;
  } finally {
    await prisma.$disconnect();
  }
}
