/**
 * Permission-gated, org-scoped listing repository (spec: Supplier console →
 * Listing management). Same security model as OrgScopedRepository: every read
 * is pinned to the acting membership's orgId, every mutation names its
 * permission and fails closed, and every write (including each lifecycle
 * transition) appends an AuditLog row inside the same transaction.
 *
 * Listing edits are draft-only: title, attributes, images, variants, MOQ
 * ladders, and lead-time bands change only while the listing is DRAFT —
 * a submitted or live listing moves through the state machine instead
 * (listing-state.ts). The staff moderation surface (pendingReviewListings,
 * publish, reject) is explicitly cross-org by design, mirroring the supplier
 * verification queue in repositories.ts.
 *
 * Attribute values validate against the category's attribute set on every
 * write via @packsource/db's Zod builders; MOQ ladders must be
 * quantity-sorted with non-increasing prices; lead-time bands must not
 * overlap.
 */
import type { ListingStatus, Prisma, PrismaClient, StockLevel } from "@packsource/db";
import { slugify, validateAttributesForCategory } from "@packsource/db";
import { assertCan, type Permission } from "./permissions";
import {
  assertListingTransition,
  assertPublishAllowed,
  LISTING_TRANSITIONS,
  LISTING_TRANSITION_AUDIT_ACTIONS,
  type ListingTransitionAction,
} from "./listing-state";
import type { ListingDraftUpdateInput, ListingUpsertInput } from "./listing-input";
import {
  ListingInputError,
  parseListingDraftUpdate,
  parseListingUpsert,
  validateLeadTimeRules,
  validateMoqLadder,
} from "./listing-input";
import { RecordNotFoundError, type AuthContext } from "./repositories";
import type { SpecExtractionPayload } from "./spec-extraction";

/** One entry of the Listing.images JSON column, including review state. */
export type ListingImageEntry = {
  url: string;
  alt?: string;
  position: number;
  /** Present while the Vision adapter's suggestion awaits human review. */
  suggestedTags?: string[];
  suggestedAlt?: string;
  suggestionStatus?: "pending" | "confirmed";
};

export interface ListingVariantUpsertInput {
  sku: string;
  barcode?: string | null;
  /** JSON-safe by construction — every writer passes Zod-validated input. */
  attributes?: Record<string, unknown>;
  unitPriceCents?: number | null;
  stockQty?: number | null;
  stockLevel?: StockLevel | null;
}

export interface ListingImageUpload {
  url: string;
  suggestedTags?: string[];
  suggestedAlt?: string;
}

/** Audit-log actions written by this repository (append-only table). */
const AUDIT = {
  create: "listing.create",
  update: "listing.update",
  variantsReplace: "listing.variants.replace",
  moqReplace: "listing.moq.replace",
  leadTimeReplace: "listing.lead_time.replace",
  specSheetUpload: "listing.spec_sheet.upload",
  specSheetExtract: "listing.spec_sheet.extract",
  specSheetApply: "listing.spec_sheet.apply",
  specSheetConfirm: "listing.spec_sheet.confirm",
  imageAdd: "listing.image.add",
  imageConfirm: "listing.image.confirm",
  import: "listing.import",
} as const;

type ListingTransitionEdge = (typeof LISTING_TRANSITIONS)[number];

const LISTING_TRANSITIONS_BY_ACTION: Record<ListingTransitionAction, ListingTransitionEdge> = Object.fromEntries(
  LISTING_TRANSITIONS.map((t) => [t.action, t]),
) as Record<ListingTransitionAction, ListingTransitionEdge>;

/** Map a transition action to its target status (the edge list is the truth). */
function transitionTarget(action: ListingTransitionAction): ListingStatus {
  const edge = LISTING_TRANSITIONS_BY_ACTION[action];
  if (!edge) {
    throw new Error(`unknown listing transition action: ${action}`);
  }
  return edge.to;
}

/** Narrows one raw JSON image entry to a typed ListingImageEntry, or null. */
function parseImageEntry(raw: Prisma.JsonValue): ListingImageEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record: Record<string, unknown> = raw;
  if (typeof record.url !== "string" || typeof record.position !== "number") {
    return null;
  }
  const entry: ListingImageEntry = { url: record.url, position: record.position };
  if (typeof record.alt === "string") {
    entry.alt = record.alt;
  }
  if (
    Array.isArray(record.suggestedTags) &&
    record.suggestedTags.every((tag) => typeof tag === "string")
  ) {
    entry.suggestedTags = record.suggestedTags;
  }
  if (typeof record.suggestedAlt === "string") {
    entry.suggestedAlt = record.suggestedAlt;
  }
  if (record.suggestionStatus === "pending" || record.suggestionStatus === "confirmed") {
    entry.suggestionStatus = record.suggestionStatus;
  }
  return entry;
}

/** Typed image entries → Prisma JSON input. JSON.stringify drops undefined
 * optional fields, which is exactly the write shape we want; round-tripping
 * here keeps every JSON write honest instead of casting at each call site. */
function imageEntriesToJson(entries: ListingImageEntry[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(entries)) as Prisma.InputJsonValue;
}

/** Parses the Listing.images JSON column for read-side consumers (pages). */
export function parseListingImages(images: Prisma.JsonValue): ListingImageEntry[] {
  if (!Array.isArray(images)) {
    return [];
  }
  return images.map(parseImageEntry).filter((entry): entry is ListingImageEntry => entry !== null);
}

/**
 * SpecExtractionPayload → Prisma JSON input. Field values are pre-validated
 * by the category Zod builders, so a round-trip through JSON.stringify is
 * safe and keeps the interface free of index-signature noise.
 */
function specPayloadToJson(payload: SpecExtractionPayload): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
}

export class ListingNotEditableError extends Error {
  constructor(readonly status: ListingStatus) {
    super(`listing is not editable while ${status} — move it back to DRAFT first`);
    this.name = "ListingNotEditableError";
  }
}

export class IncompleteListingError extends Error {
  constructor(readonly problems: string[]) {
    super(`listing is not ready for review: ${problems.join("; ")}`);
    this.name = "IncompleteListingError";
  }
}

const listingInclude = {
  variants: { orderBy: { createdAt: "asc" } },
  moqTiers: { orderBy: { minQty: "asc" } },
  leadTimes: { orderBy: { qtyMin: "asc" } },
  specSheets: { orderBy: { createdAt: "asc" } },
  category: { select: { slug: true, name: true } },
} satisfies Prisma.ListingInclude;

export type ListingWithRelations = Prisma.ListingGetPayload<{ include: typeof listingInclude }>;

/** The listing row as resolved by #ownedListing (with category + review children). */
type OwnedListingRow = Prisma.ListingGetPayload<{
  include: { category: { select: { slug: true } }; moqTiers: true; leadTimes: true; specSheets: true };
}>;

export class ListingRepository {
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
    entityId: string,
    orgId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType: "Listing",
        entityId,
        after,
      },
    });
  }

  // ── reads (org-scoped) ─────────────────────────────────────────────────────

  /** This org's listings, newest first, optionally filtered by status. */
  async listings(options: { status?: ListingStatus } = {}) {
    return this.#db.listing.findMany({
      where: { orgId: this.#auth.orgId, ...(options.status ? { status: options.status } : {}) },
      orderBy: { createdAt: "desc" },
      include: { moqTiers: { orderBy: { minQty: "asc" } }, category: { select: { slug: true, name: true } } },
    });
  }

  /** One owned listing with variants, ladders, lead times, and spec sheets. */
  async listing(id: string): Promise<ListingWithRelations> {
    const listing = await this.#db.listing.findFirst({
      where: { id, orgId: this.#auth.orgId },
      include: listingInclude,
    });
    if (!listing) {
      throw new RecordNotFoundError("Listing", id);
    }
    return listing;
  }

  // ── staff moderation surface (cross-org by design) ────────────────────────

  /** Listings awaiting review — moderation:manage only, explicitly cross-org. */
  async pendingReviewListings() {
    this.#require("moderation:manage");
    return this.#db.listing.findMany({
      where: { status: "PENDING_REVIEW" },
      orderBy: { updatedAt: "asc" },
      include: { org: { select: { name: true, slug: true } }, category: { select: { slug: true, name: true } } },
    });
  }

  // ── create / edit (listing:manage, draft-only) ────────────────────────────

  /** Creates a DRAFT listing with its MOQ ladder, lead times, and variants. */
  async createListing(input: ListingUpsertInput): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    const data = parseListingUpsert(input);
    const category = await this.#categoryBySlug(data.categorySlug);
    const attributes = validateAttributesForCategory(category.slug, data.attributes);
    validateMoqLadder(data.moqTiers ?? []);
    validateLeadTimeRules(data.leadTimeRules ?? []);

    const created = await this.#db.$transaction(async (tx) => {
      const slug = await this.#uniqueSlug(tx, slugify(data.title));
      const listing = await tx.listing.create({
        data: {
          orgId: this.#auth.orgId,
          categoryId: category.id,
          title: data.title,
          slug,
          description: data.description ?? null,
          status: "DRAFT",
          attributes,
          images: imageEntriesToJson((data.images ?? []).map((image, position) => ({ ...image, position }))),
          stockLevel: data.stockLevel ?? null,
          capacityUnitsPerWeek: data.capacityUnitsPerWeek ?? null,
          variants: {
            create: (data.variants ?? []).map((variant) => ({
              sku: variant.sku,
              barcode: variant.barcode ?? null,
              attributes: variant.attributes as Prisma.InputJsonValue | undefined,
              unitPriceCents: variant.unitPriceCents ?? null,
              stockQty: variant.stockQty ?? null,
              stockLevel: variant.stockLevel ?? null,
              orgId: this.#auth.orgId,
            })),
          },
          moqTiers: {
            create: (data.moqTiers ?? []).map((tier) => ({ ...tier, orgId: this.#auth.orgId })),
          },
          leadTimes: {
            create: (data.leadTimeRules ?? []).map((rule) => ({ ...rule, orgId: this.#auth.orgId })),
          },
        },
        include: listingInclude,
      });
      await this.#audit(tx, AUDIT.create, listing.id, this.#auth.orgId, { status: "DRAFT" });
      return listing;
    });
    return created as ListingWithRelations;
  }

  /** Draft-only edit of the listing core, re-validating category attributes. */
  async updateListingDraft(id: string, input: ListingDraftUpdateInput): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    const data = parseListingDraftUpdate(input);
    const owned = await this.#ownedListing(id);
    this.#assertEditable(owned.status);

    const category = await this.#categoryBySlug(data.categorySlug ?? owned.category.slug);
    const attributes =
      data.attributes === undefined ? undefined : validateAttributesForCategory(category.slug, data.attributes);

    return this.#db.$transaction(async (tx) => {
      const updated = await tx.listing.update({
        where: { id: owned.id },
        data: {
          categoryId: category.id,
          title: data.title ?? undefined,
          description: data.description ?? undefined,
          attributes: attributes ?? undefined,
          images:
            data.images === undefined
              ? undefined
              : imageEntriesToJson(data.images.map((image, position) => ({ ...image, position }))),
          stockLevel: data.stockLevel ?? undefined,
          capacityUnitsPerWeek: data.capacityUnitsPerWeek ?? undefined,
        },
        include: listingInclude,
      });
      await this.#audit(tx, AUDIT.update, updated.id, this.#auth.orgId);
      return updated as ListingWithRelations;
    });
  }

  /** Replaces the MOQ price ladder (draft-only; quantity-sorted tiers). */
  async replaceMoqLadder(
    id: string,
    tiers: readonly { minQty: number; unitPriceCents: number }[],
  ): Promise<void> {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(id);
    this.#assertEditable(owned.status);
    validateMoqLadder(tiers);
    await this.#db.$transaction(async (tx) => {
      await tx.moqPriceTier.deleteMany({ where: { listingId: owned.id } });
      if (tiers.length > 0) {
        await tx.moqPriceTier.createMany({
          data: tiers.map((tier) => ({
            listingId: owned.id,
            orgId: this.#auth.orgId,
            minQty: tier.minQty,
            unitPriceCents: tier.unitPriceCents,
          })),
        });
      }
      await this.#audit(tx, AUDIT.moqReplace, owned.id, this.#auth.orgId, { tierCount: tiers.length });
    });
  }

  /** Replaces the lead-time bands (draft-only; non-overlapping). */
  async replaceLeadTimeRules(
    id: string,
    rules: readonly { qtyMin: number; qtyMax: number | null; productionDays: number }[],
  ): Promise<void> {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(id);
    this.#assertEditable(owned.status);
    validateLeadTimeRules(rules);
    await this.#db.$transaction(async (tx) => {
      await tx.leadTimeRule.deleteMany({ where: { listingId: owned.id } });
      if (rules.length > 0) {
        await tx.leadTimeRule.createMany({
          data: rules.map((rule) => ({
            listingId: owned.id,
            orgId: this.#auth.orgId,
            qtyMin: rule.qtyMin,
            qtyMax: rule.qtyMax,
            productionDays: rule.productionDays,
          })),
        });
      }
      await this.#audit(tx, AUDIT.leadTimeReplace, owned.id, this.#auth.orgId, { ruleCount: rules.length });
    });
  }

  /** Replaces the variant list (draft-only; unique SKUs within the listing). */
  async replaceVariants(id: string, variants: readonly ListingVariantUpsertInput[]): Promise<void> {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(id);
    this.#assertEditable(owned.status);
    const skus = variants.map((v) => v.sku);
    if (new Set(skus).size !== skus.length) {
      throw new ListingInputError("variant SKUs must be unique within a listing");
    }
    await this.#db.$transaction(async (tx) => {
      await tx.listingVariant.deleteMany({ where: { listingId: owned.id } });
      if (variants.length > 0) {
        await tx.listingVariant.createMany({
          data: variants.map((variant) => ({
            listingId: owned.id,
            orgId: this.#auth.orgId,
            sku: variant.sku,
            barcode: variant.barcode ?? null,
            attributes: variant.attributes as Prisma.InputJsonValue | undefined,
            unitPriceCents: variant.unitPriceCents ?? null,
            stockQty: variant.stockQty ?? null,
            stockLevel: variant.stockLevel ?? null,
          })),
        });
      }
      await this.#audit(tx, AUDIT.variantsReplace, owned.id, this.#auth.orgId, { variantCount: variants.length });
    });
  }

  // ── lifecycle transitions ───────────────────────────────────────────────────

  /**
   * The one gateway between statuses and the state machine. Resolves the
   * listing (scoped by org for supplier actions, cross-org for staff
   * moderation), asserts the edge is legal, checks the actor's permission,
   * applies the status write, and audits the transition — all in one
   * transaction so an illegal move can never half-land.
   */
  async #transition(
    listingId: string,
    action: ListingTransitionAction,
    options: { crossOrg?: boolean; reason?: string } = {},
  ): Promise<ListingWithRelations> {
    return this.#db.$transaction(async (tx) => {
      const listing = await (options.crossOrg
        ? tx.listing.findFirst({ where: { id: listingId }, include: { specSheets: true } })
        : tx.listing.findFirst({ where: { id: listingId, orgId: this.#auth.orgId }, include: { specSheets: true } }));
      if (!listing) {
        throw new RecordNotFoundError("Listing", listingId);
      }

      const transition = assertListingTransition(listing.status, transitionTarget(action));
      assertCan(this.#auth.role, transition.permission);

      // The publish gate: never go LIVE with unconfirmed extraction suggestions.
      if (transition.to === "LIVE") {
        assertPublishAllowed(listing.specSheets);
      }

      const auditOrgId = options.crossOrg ? listing.orgId : this.#auth.orgId;
      const after: { status: ListingStatus; reason?: string } = { status: transition.to };
      if (options.reason !== undefined) {
        after.reason = options.reason;
      }

      const updated = await tx.listing.update({
        where: { id: listing.id },
        data: {
          status: transition.to,
          publishedAt: transition.to === "LIVE" ? (listing.publishedAt ?? new Date()) : undefined,
        },
        include: listingInclude,
      });

      await this.#audit(tx, LISTING_TRANSITION_AUDIT_ACTIONS[action], listing.id, auditOrgId, after);
      return updated as ListingWithRelations;
    });
  }

  /** Supplier submits a complete draft for moderation review. */
  async submitForReview(listingId: string): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(listingId);
    if (owned.status !== "DRAFT") {
      // Fail before the completeness scan so the message names the state issue.
      assertListingTransition(owned.status, "PENDING_REVIEW");
    }
    const problems = await this.#completenessProblems(owned);
    if (problems.length > 0) {
      throw new IncompleteListingError(problems);
    }
    return this.#transition(listingId, "submit");
  }

  /** Staff approves a submitted listing (publish-only-after-submit holds). */
  async publish(listingId: string): Promise<ListingWithRelations> {
    this.#require("moderation:manage");
    return this.#transition(listingId, "publish", { crossOrg: true });
  }

  /** Staff declines a submitted listing, with a reason for the supplier. */
  async reject(listingId: string, reason: string): Promise<ListingWithRelations> {
    this.#require("moderation:manage");
    return this.#transition(listingId, "reject", { crossOrg: true, reason });
  }

  /** Supplier takes a live listing off the market. */
  async unpublish(listingId: string): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    return this.#transition(listingId, "unpublish");
  }

  /** Supplier re-lists a previously approved listing. */
  async republish(listingId: string): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    return this.#transition(listingId, "republish");
  }

  /** Supplier pulls a paused listing back into the editor. */
  async resumeEditing(listingId: string): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    return this.#transition(listingId, "resumeEditing");
  }

  /** Supplier pulls a submitted listing back to DRAFT. */
  async withdraw(listingId: string): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    return this.#transition(listingId, "withdraw");
  }

  /** Supplier reopens a rejected listing to address moderation feedback. */
  async revise(listingId: string): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    return this.#transition(listingId, "revise");
  }

  // ── spec sheets (extraction review workflow) ──────────────────────────────

  /** Registers an uploaded spec sheet (mock Storage key), status UPLOADED. */
  async addSpecSheet(
    listingId: string,
    input: { fileId: string; title: string },
  ) {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(listingId);
    this.#assertEditable(owned.status);
    const sheet = await this.#db.$transaction(async (tx) => {
      const created = await tx.specSheet.create({
        data: {
          listingId: owned.id,
          orgId: this.#auth.orgId,
          fileId: input.fileId,
          title: input.title,
        },
      });
      await this.#audit(tx, AUDIT.specSheetUpload, owned.id, this.#auth.orgId, { specSheetId: created.id });
      return created;
    });
    return sheet;
  }

  /**
   * Stores extraction suggestions on a spec sheet. The caller runs the
   * reasoning adapter + deterministic extractor (web layer owns adapters);
   * this only persists the reviewable payload — nothing touches the listing.
   */
  async recordSpecExtraction(
    listingId: string,
    specSheetId: string,
    payload: SpecExtractionPayload,
  ) {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(listingId);
    this.#assertEditable(owned.status);
    return this.#db.$transaction(async (tx) => {
      const sheet = await tx.specSheet.update({
        where: { id: await this.#ownedSpecSheetId(tx, owned.id, specSheetId) },
        data: { extractionStatus: "EXTRACTED", extractedAttributes: specPayloadToJson(payload) },
      });
      await this.#audit(tx, AUDIT.specSheetExtract, owned.id, this.#auth.orgId, {
        specSheetId,
        suggestionCount: payload.suggestions.length,
        reasoningModel: payload.reasoningModel,
      });
      return sheet;
    });
  }

  /** Marks extraction extraction FAILED (adapter errors must not strand UPLOADED). */
  async failSpecExtraction(listingId: string, specSheetId: string) {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(listingId);
    this.#assertEditable(owned.status);
    return this.#db.$transaction(async (tx) => {
      const sheet = await tx.specSheet.update({
        where: { id: await this.#ownedSpecSheetId(tx, owned.id, specSheetId) },
        data: { extractionStatus: "FAILED" },
      });
      await this.#audit(tx, AUDIT.specSheetExtract, owned.id, this.#auth.orgId, { specSheetId, failed: true });
      return sheet;
    });
  }

  /**
   * Human review step 1: apply chosen suggestions into the draft's attribute
   * values (merged, then validated as a whole against the category set).
   * DRAFT-only — suggestions never touch submitted or live listings.
   */
  async applySpecSuggestions(
    listingId: string,
    specSheetId: string,
    keys?: readonly string[],
  ): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(listingId);
    this.#assertEditable(owned.status);

    const sheet = await this.#db.specSheet.findFirst({
      where: { id: specSheetId, listingId: owned.id, orgId: this.#auth.orgId },
    });
    if (!sheet || sheet.extractionStatus !== "EXTRACTED") {
      throw new RecordNotFoundError("SpecSheet with extraction suggestions", specSheetId);
    }
    const payload = sheet.extractedAttributes as SpecExtractionPayload | null;
    const suggestions = (payload?.suggestions ?? []).filter((s) => !keys || keys.includes(s.key));
    if (suggestions.length === 0) {
      throw new RecordNotFoundError("suggestions to apply", specSheetId);
    }

    return this.#db.$transaction(async (tx) => {
      const merged = { ...(owned.attributes as Record<string, unknown>) };
      for (const item of suggestions) {
        merged[item.key] = item.value;
      }
      const attributes = validateAttributesForCategory(owned.category.slug, merged);
      const updated = await tx.listing.update({
        where: { id: owned.id },
        data: { attributes },
        include: listingInclude,
      });
      await this.#audit(tx, AUDIT.specSheetApply, owned.id, this.#auth.orgId, {
        specSheetId,
        appliedKeys: suggestions.map((s) => s.key),
      });
      return updated as ListingWithRelations;
    });
  }

  /**
   * Human review step 2: confirm the sheet's extraction was reviewed. Clears
   * the publish gate for this sheet (listing-state.ts).
   */
  async confirmSpecSheet(listingId: string, specSheetId: string) {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(listingId);
    return this.#db.$transaction(async (tx) => {
      const sheet = await tx.specSheet.update({
        where: { id: await this.#ownedSpecSheetId(tx, owned.id, specSheetId) },
        data: { extractionStatus: "CONFIRMED", confirmedAt: new Date(), confirmedByUserId: this.#auth.userId },
      });
      await this.#audit(tx, AUDIT.specSheetConfirm, owned.id, this.#auth.orgId, { specSheetId });
      return sheet;
    });
  }

  // ── images (Vision-adapter suggestion workflow) ───────────────────────────

  /** Appends an uploaded image with its pending Vision suggestion (DRAFT-only). */
  async addImage(listingId: string, image: ListingImageUpload): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(listingId);
    this.#assertEditable(owned.status);
    const images = this.#imagesOf(owned);
    const entry: ListingImageEntry = {
      url: image.url,
      position: images.length,
      suggestedTags: image.suggestedTags,
      suggestedAlt: image.suggestedAlt,
      suggestionStatus: image.suggestedTags ? "pending" : undefined,
    };
    return this.#db.$transaction(async (tx) => {
      const updated = await tx.listing.update({
        where: { id: owned.id },
        data: { images: imageEntriesToJson([...images, entry]) },
        include: listingInclude,
      });
      await this.#audit(tx, AUDIT.imageAdd, owned.id, this.#auth.orgId, { position: entry.position });
      return updated as ListingWithRelations;
    });
  }

  /** Human review: confirm an image's suggestion, optionally with edited alt. */
  async confirmImage(
    listingId: string,
    position: number,
    alt?: string,
  ): Promise<ListingWithRelations> {
    this.#require("listing:manage");
    const owned = await this.#ownedListing(listingId);
    this.#assertEditable(owned.status);
    const images = this.#imagesOf(owned);
    const entry = images[position];
    if (!entry) {
      throw new RecordNotFoundError("image at position", String(position));
    }
    const confirmed: ListingImageEntry = {
      ...entry,
      alt: alt ?? entry.suggestedAlt ?? entry.alt,
      suggestionStatus: "confirmed",
    };
    delete confirmed.suggestedTags;
    delete confirmed.suggestedAlt;
    const next = images.map((image, i) => (i === position ? confirmed : image));
    return this.#db.$transaction(async (tx) => {
      const updated = await tx.listing.update({
        where: { id: owned.id },
        data: { images: imageEntriesToJson(next) },
        include: listingInclude,
      });
      await this.#audit(tx, AUDIT.imageConfirm, owned.id, this.#auth.orgId, { position });
      return updated as ListingWithRelations;
    });
  }

  // ── transaction-internal helpers ───────────────────────────────────────────

  async #ownedListing(id: string) {
    const listing = await this.#db.listing.findFirst({
      where: { id, orgId: this.#auth.orgId },
      include: { category: { select: { slug: true } }, moqTiers: true, leadTimes: true, specSheets: true },
    });
    if (!listing) {
      throw new RecordNotFoundError("Listing", id);
    }
    return listing;
  }

  #assertEditable(status: ListingStatus): void {
    if (status !== "DRAFT") {
      throw new ListingNotEditableError(status);
    }
  }

  #imagesOf(listing: { images: Prisma.JsonValue }): ListingImageEntry[] {
    if (!Array.isArray(listing.images)) {
      return [];
    }
    // JSON column → typed entries: keep only objects with our required fields
    // so a hand-edited row can never crash the editor.
    const entries: ListingImageEntry[] = [];
    for (const raw of listing.images) {
      const entry = parseImageEntry(raw);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }

  async #categoryBySlug(slug: string) {
    const category = await this.#db.category.findUnique({ where: { slug } });
    if (!category) {
      throw new RecordNotFoundError("Category", slug);
    }
    return category;
  }

  /** Submit readiness: title, valid attributes, MOQ ladder, lead times. */
  async #completenessProblems(listing: OwnedListingRow): Promise<string[]> {
    const problems: string[] = [];
    if (listing.title.trim().length < 3) {
      problems.push("title must be at least 3 characters");
    }
    try {
      validateAttributesForCategory(listing.category.slug, listing.attributes);
    } catch (error) {
      problems.push(`attributes invalid for category: ${(error as Error).message}`);
    }
    if (listing.moqTiers.length === 0) {
      problems.push("at least one MOQ price tier is required");
    }
    if (listing.leadTimes.length === 0) {
      problems.push("at least one lead-time rule is required");
    }
    return problems;
  }

  async #ownedSpecSheetId(tx: Prisma.TransactionClient, listingId: string, specSheetId: string): Promise<string> {
    const sheet = await tx.specSheet.findFirst({
      where: { id: specSheetId, listingId, orgId: this.#auth.orgId },
      select: { id: true },
    });
    if (!sheet) {
      throw new RecordNotFoundError("SpecSheet", specSheetId);
    }
    return sheet.id;
  }

  /** Collision-proof slug: base, base-2, base-3… — deterministic and unique. */
  async #uniqueSlug(tx: Prisma.TransactionClient, base: string): Promise<string> {
    const taken = await tx.listing.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    const used = new Set(taken.map((row) => row.slug));
    if (!used.has(base)) {
      return base;
    }
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!used.has(candidate)) {
        return candidate;
      }
    }
  }
}
