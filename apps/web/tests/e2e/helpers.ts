import type { Page } from "@playwright/test";
import { PrismaClient } from "@packsource/db";
import { RfqRepository, type AuthContext } from "@packsource/core";

/**
 * Shared e2e helpers. Zero API keys: sessions come from the password
 * credentials provider against users seeded by global-setup. The one
 * server-side bootstrap (bootstrapSentRfq) exists to keep the long trade
 * journey fast; the UI creation+send leg is exercised for real in
 * rfq-ui-create.spec.ts.
 */

export const E2E_PASSWORD = "e2e-password-123";

/** Seeded/created by global-setup; org slugs and ids come from the deterministic seed. */
export const BUYER_EMAIL = "buyer@e2e.packsource.test";
export const SALES_EMAIL = "sales@e2e.packsource.test";
export const OPS_EMAIL = "ops@e2e.packsource.test";
export const STAFF_EMAIL = "staff@e2e.packsource.test";

/** Live seeded listing (verified: seed_listing_0001, seed_org_supplier_001, rigid). */
export const TARGET_LISTING_ID = "seed_listing_0001";
export const TARGET_LISTING_SLUG = "seed-listing-0001";
/** Second live seeded listing, owned by a different supplier — used by the compare flow. */
export const OTHER_LISTING_SLUG = "seed-listing-0002";

/** Fixed title so inbox/dashboard lookups are stable and reruns are idempotent-ish. */
export const JOURNEY_RFQ_TITLE = "E2E — 32oz PP Cup run";

/**
 * The accepted quote's order id. The accept form renders errors only (no
 * success message), so the order is resolved through the quote → order link.
 */
export async function orderForRfq(rfqId: string): Promise<string | null> {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const order = await prisma.order.findFirst({
      where: { quote: { rfqId } },
      orderBy: { createdAt: "desc" },
    });
    return order?.id ?? null;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Category of a seeded listing, resolved at runtime — the seed assigns
 * categories programmatically (round-robin over the flattened taxonomy),
 * so the spec never hardcodes a category name or id.
 */
export async function listingCategoryFor(listingId: string): Promise<{ categoryId: string; categoryName: string }> {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      select: { categoryId: true, category: { select: { name: true } } },
    });
    if (!listing) {
      throw new Error(`seeded listing ${listingId} is missing — run global-setup`);
    }
    return { categoryId: listing.categoryId, categoryName: listing.category.name };
  } finally {
    await prisma.$disconnect();
  }
}

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
 * use. The UI create+send leg is now exercised for real in
 * rfq-ui-create.spec.ts; this repository bootstrap remains only because the
 * full trade journey (quotes → award → escrow → payout) does not need a
 * second UI pass for its setup and the repository route keeps that long
 * spec fast. Returns the rfq id for UI navigation.
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
    // Always create a fresh RFQ: title carries a run-unique suffix so prior
    // runs (whose negotiation may be mid-flight or awarded) never pollute
    // this run's quote list or thread.
    const rfq = await rfqRepository.create({
      mode: "SINGLE",
      title: `${input.title} ${Date.now().toString(36)}`,
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
