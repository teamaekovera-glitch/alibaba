import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyBroadcastError, InvalidRfqError } from "@packsource/core";
import { parseCreateRfqForm } from "../../src/lib/rfq-form";
import type { RfqListingContext } from "../../src/lib/rfq-form";

/**
 * RFQ-creation form validation (the defect behind the UI-RFQ repair: the
 * lean form could not express a category, so UI-created broadcast RFQs were
 * rejected by the domain at send time). The parser is the action's complete
 * validation surface: broadcast/auction RFQs must carry a categoryId (it is
 * what the SQL matcher scopes suppliers to), SINGLE-listing RFQs inherit the
 * category from the listing context the server resolved.
 */

const LISTING: RfqListingContext = {
  id: "listing_1",
  title: "32oz kraft stand-up pouch",
  categoryId: "cat_rigid",
  categoryName: "Rigid",
};

function form(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return form;
}

const broadcastFields = {
  mode: "BROADCAST",
  title: "32oz stand-up pouches, kraft",
  quantity: "2500",
};

describe("parseCreateRfqForm — broadcast category requirement", () => {
  it("rejects a BROADCAST RFQ with no category", () => {
    const parsed = parseCreateRfqForm(form(broadcastFields));
    expect(parsed).toEqual({
      errors: ["category is required — broadcast RFQs match suppliers within one category"],
    });
  });

  it("rejects an AUCTION RFQ with no category (same matching scope)", () => {
    const parsed = parseCreateRfqForm(form({ ...broadcastFields, mode: "AUCTION" }));
    expect(parsed).toEqual({
      errors: ["category is required — broadcast RFQs match suppliers within one category"],
    });
  });

  it("carries the chosen category through to the created input", () => {
    const parsed = parseCreateRfqForm(form({ ...broadcastFields, categoryId: "cat_rigid" }));
    if (!("input" in parsed)) throw new Error("expected a successful parse");
    expect(parsed.input.categoryId).toBe("cat_rigid");
    expect(parsed.input.mode).toBe("BROADCAST");
    expect(parsed.input.title).toBe("32oz stand-up pouches, kraft");
    expect(parsed.input.quantity).toBe(2500);
    expect(parsed.input.listingId).toBeNull();
  });

  it("treats a whitespace-only category as missing", () => {
    const parsed = parseCreateRfqForm(form({ ...broadcastFields, categoryId: "   " }));
    expect(parsed).toEqual({
      errors: ["category is required — broadcast RFQs match suppliers within one category"],
    });
  });
});

describe("parseCreateRfqForm — single-listing category inheritance", () => {
  it("resolves the category from the listing context", () => {
    const parsed = parseCreateRfqForm(form({ mode: "SINGLE", title: "pouch run", quantity: "1200", listingId: LISTING.id }), LISTING);
    if (!("input" in parsed)) throw new Error("expected a successful parse");
    expect(parsed.input.mode).toBe("SINGLE");
    expect(parsed.input.listingId).toBe(LISTING.id);
    expect(parsed.input.categoryId).toBe(LISTING.categoryId);
  });

  it("rejects SINGLE mode with no listing id at all", () => {
    const parsed = parseCreateRfqForm(form({ mode: "SINGLE", title: "pouch run", quantity: "1200" }), null);
    expect(parsed).toEqual({ errors: ["a single-listing RFQ requires a target listing"] });
  });

  it("passes an unloadable listing through to the repository (typed domain error, not a guessed category)", () => {
    const parsed = parseCreateRfqForm(form({ mode: "SINGLE", title: "pouch run", quantity: "1200", listingId: "gone" }), null);
    if (!("input" in parsed)) throw new Error("expected a successful parse");
    expect(parsed.input.listingId).toBe("gone");
    expect(parsed.input.categoryId).toBeNull();
  });
});

describe("parseCreateRfqForm — shape validation", () => {
  it("rejects an unknown mode", () => {
    const parsed = parseCreateRfqForm(form({ ...broadcastFields, mode: "STEALTH", categoryId: "cat_rigid" }));
    expect(parsed).toEqual({ errors: ["RFQ mode must be BROADCAST, AUCTION, or SINGLE"] });
  });

  it("rejects an empty title", () => {
    const parsed = parseCreateRfqForm(form({ ...broadcastFields, title: "  ", categoryId: "cat_rigid" }));
    expect(parsed).toEqual({ errors: ["title is required"] });
  });

  it("rejects non-positive or non-integer quantities", () => {
    for (const quantity of ["0", "-5", "2.5", "ten", ""]) {
      const parsed = parseCreateRfqForm(form({ ...broadcastFields, quantity, categoryId: "cat_rigid" }));
      expect(parsed).toEqual({ errors: ["quantity must be a positive whole number"] });
    }
  });

  it("rejects unparsable destinations with the documented shape", () => {
    const parsed = parseCreateRfqForm(form({ ...broadcastFields, categoryId: "cat_rigid", destination: "somewhere in Texas" }));
    if (!("errors" in parsed)) throw new Error("expected parse errors");
    expect(parsed.errors[0]).toContain('destination must look like "Austin, TX 78701"');
  });

  it("parses a structured destination and need-by into the spec envelope", () => {
    const parsed = parseCreateRfqForm(
      form({ ...broadcastFields, categoryId: "cat_rigid", destination: "Austin, TX 78701", needBy: "2030-06-30" }),
    );
    if (!("input" in parsed)) throw new Error("expected a successful parse");
    expect(parsed.input.spec).toEqual({
      version: 1,
      destination: { city: "Austin", state: "TX", country: "US", postalCode: "78701" },
      needByDate: "2030-06-30",
    });
  });

  it("collects every problem at once instead of failing fast", () => {
    const parsed = parseCreateRfqForm(form({ mode: "BROADCAST", title: "", quantity: "-1" }));
    if (!("errors" in parsed)) throw new Error("expected parse errors");
    expect(parsed.errors).toHaveLength(3);
  });
});

// ── action wiring ────────────────────────────────────────────────────────────
// The server action is a thin adapter: parse -> rfq.create -> translate
// domain errors. Mocked here at the seams (@/lib/trade, the listing-context
// loader, next/cache) to prove the category actually reaches the repository.

const trade = vi.hoisted(() => ({
  rfqCreate: vi.fn(),
  rfqSend: vi.fn(),
  loadListing: vi.fn(),
}));

vi.mock("@/lib/trade", () => ({
  tradeRepositories: async () => ({
    authContext: { userId: "user_1", orgId: "org_buyer", role: "OWNER" },
    rfq: { create: trade.rfqCreate, send: trade.rfqSend },
  }),
}));

vi.mock("@/lib/rfq-listing-context", () => ({
  loadRfqListingContext: trade.loadListing,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
}));

vi.mock("next/navigation", () => ({
  // Next's redirect() signals navigation by throwing a control-flow error
  // with a NEXT_REDIRECT digest; mirror that shape so the action's
  // success-path tests can assert the destination.
  redirect: (url: string) => {
    const error = new Error(`NEXT_REDIRECT: ${url}`) as Error & { digest?: string };
    error.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const { createRfqAction, sendRfqAction } = await import("../../src/app/rfq/actions");

describe("createRfqAction", () => {
  beforeEach(() => {
    trade.rfqCreate.mockReset();
    trade.rfqSend.mockReset();
    trade.loadListing.mockReset();
    trade.loadListing.mockImplementation(async () => LISTING);
  });

  it("rejects a missing category before the repository is called", async () => {
    const result = await createRfqAction(null, form(broadcastFields));
    expect(result).toEqual({
      error: "category is required — broadcast RFQs match suppliers within one category",
    });
    expect(trade.rfqCreate).not.toHaveBeenCalled();
  });

  it("persists the chosen category through to rfq.create and redirects to the draft", async () => {
    trade.rfqCreate.mockResolvedValue({ id: "rfq_1" });
    // Success is signalled by Next's redirect() control-flow throw.
    await expect(
      createRfqAction(null, form({ ...broadcastFields, categoryId: "cat_rigid" })),
    ).rejects.toMatchObject({ digest: expect.stringContaining("/rfq/rfq_1") });
    expect(trade.rfqCreate).toHaveBeenCalledTimes(1);
    const input = trade.rfqCreate.mock.calls[0]?.[0];
    expect(input?.categoryId).toBe("cat_rigid");
    expect(input?.mode).toBe("BROADCAST");
  });

  it("resolves the SINGLE-listing category from the loaded listing context and redirects", async () => {
    trade.rfqCreate.mockResolvedValue({ id: "rfq_2" });
    await expect(
      createRfqAction(
        null,
        form({ mode: "SINGLE", title: "pouch run", quantity: "1200", listingId: LISTING.id }),
      ),
    ).rejects.toMatchObject({ digest: expect.stringContaining("/rfq/rfq_2") });
    const input = trade.rfqCreate.mock.calls[0]?.[0];
    expect(input?.mode).toBe("SINGLE");
    expect(input?.listingId).toBe(LISTING.id);
    expect(input?.categoryId).toBe(LISTING.categoryId);
  });

  it("surfaces domain rejections (e.g. broadcast to zero suppliers) as form copy", async () => {
    // The action's own parse succeeds; the domain rejects the send path.
    trade.rfqCreate.mockRejectedValue(new InvalidRfqError("BROADCAST RFQs require a categoryId"));
    const result = await createRfqAction(null, form({ ...broadcastFields, categoryId: "cat_rigid" }));
    expect(result).toEqual({ error: "BROADCAST RFQs require a categoryId" });
  });
});

describe("sendRfqAction", () => {
  it("renders an empty broadcast as a form error instead of an uncaught 500", async () => {
    trade.rfqSend.mockRejectedValue(
      new EmptyBroadcastError("no suppliers to send to — no live listings matched this RFQ's category, MOQ, and attributes"),
    );
    const form = new FormData();
    form.set("rfqId", "rfq_1");
    const result = await sendRfqAction(null, form);
    expect(result).toEqual({
      error: "no suppliers to send to — no live listings matched this RFQ's category, MOQ, and attributes",
    });
  });
});
