/**
 * The Rfq.spec JSON envelope: structured spec attributes (validated against
 * the category's attribute set — partial, since an RFQ is a wish, not a
 * listing), destination, and need-by date. The schema's Rfq model has no
 * dedicated columns for destination/need-by, so the envelope is the typed
 * home — validated on every write path that persists Rfq.spec.
 */
import { z } from "zod";
import { attributeSetForSlug, safeValidatePartialAttributes } from "@packsource/db";

export const destinationSchema = z
  .object({
    city: z.string().min(1),
    state: z.string().min(1).optional(),
    country: z.string().min(1),
    postalCode: z.string().min(1).optional(),
  })
  .strict();

export type RfqDestination = z.infer<typeof destinationSchema>;

export const rfqSpecSchema = z
  .object({
    version: z.literal(1),
    /** Structured attributes, category-scoped and strictly partial. */
    attributes: z.record(z.string(), z.unknown()).optional(),
    destination: destinationSchema.optional(),
    /** ISO yyyy-mm-dd. */
    needByDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "needByDate must be an ISO date (yyyy-mm-dd)").optional(),
  })
  .strict();

export type RfqSpec = z.infer<typeof rfqSpecSchema>;

export class InvalidRfqSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRfqSpecError";
  }
}

/**
 * Validate an incoming spec (before persistence). When a category slug is
 * provided, its `attributes` must all be keys of that category's attribute
 * set with well-formed values; unknown keys are rejected.
 */
export function parseRfqSpec(input: unknown, options: { categorySlug?: string | null } = {}): RfqSpec {
  const parsed = rfqSpecSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new InvalidRfqSpecError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  const spec = parsed.data;
  if (spec.attributes && options.categorySlug) {
    const set = attributeSetForSlug(options.categorySlug);
    if (!set) {
      throw new InvalidRfqSpecError(`Unknown category slug: ${options.categorySlug}`);
    }
    const result = safeValidatePartialAttributes(set, spec.attributes);
    if (!result.success) {
      throw new InvalidRfqSpecError(result.error.message);
    }
    return { ...spec, attributes: result.data };
  }
  return spec;
}
