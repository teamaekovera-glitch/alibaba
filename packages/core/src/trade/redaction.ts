/**
 * Contact-sharing redaction (spec: "RFQ → quote → order" — contact-sharing
 * policy). Supplier and buyer emails and phone numbers are stripped from
 * message content and API serializers until the policy unlocks:
 *
 *   (a) a quote from that supplier has been accepted into an order, or
 *   (b) the buyer org is a verified buyer (AEKOVERA_VETTED, or three
 *       delivered orders).
 *
 * Enforcement is layered: `redactContactInfo` runs on WRITE so raw contact
 * details are never persisted, and again in the read serializer so nothing
 * leaks through pre-policy rows. `canShareContacts` is the pure policy both
 * layers consult.
 */

/** Placeholder left where contact details were removed. */
export const REDACTED_CONTACT_PLACEHOLDER = "[contact info removed]";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Phone-shaped candidates: digit groups joined by phone separators
 * (spaces, dots, dashes, parentheses), optionally with a country code.
 * Guards reject currency/quantities ("100,000", "$5.00", "12oz") by
 * requiring separator structure and forbidding letters/comma adjacency.
 */
const PHONE_RE =
  /(?<![\w.,$#])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,3}\)[\s.-]?|\d{2,4}[\s.-])\d{2,4}([ .-])\d{2,4}(?:\1\d{2,4})?(?![\w.,$#])/g;

/**
 * Strip emails and phone numbers from free text. Runs on every negotiation
 * message body before persistence and again in the read serializer.
 */
export function redactContactInfo(text: string): string {
  let redacted = text.replace(EMAIL_RE, REDACTED_CONTACT_PLACEHOLDER);
  redacted = redacted.replace(PHONE_RE, (match) =>
    digitsOnly(match).length >= 7 ? REDACTED_CONTACT_PLACEHOLDER : match,
  );
  return redacted;
}

/** True when free text still contains an email- or phone-shaped substring. */
export function hasContactInfo(text: string): boolean {
  if ((text.match(EMAIL_RE) ?? []).length > 0) {
    return true;
  }
  const phones = text.match(PHONE_RE) ?? [];
  return phones.some((candidate) => digitsOnly(candidate).length >= 7);
}

function digitsOnly(text: string): string {
  return text.replace(/\D/g, "");
}

/** Why contact sharing is (or is not) unlocked for a buyer–supplier pair. */
export interface ContactSharingInput {
  /** A quote from THIS supplier was accepted into an order for this buyer. */
  quoteAccepted: boolean;
  /** Buyer org verification status (schema: SupplierProfile.verificationStatus). */
  buyerVerificationStatus: "UNVERIFIED" | "VERIFIED" | "AEKOVERA_VETTED" | null;
  /** Count of the buyer org's delivered orders. */
  buyerDeliveredOrders: number;
}

/** Delivered-orders threshold for verified-buyer contact unlocking (spec). */
export const VERIFIED_BUYER_DELIVERED_ORDERS = 3;

/** The pure contact-sharing policy: unlocked at quote acceptance or verified-buyer status. */
export function canShareContacts(input: ContactSharingInput): boolean {
  if (input.quoteAccepted) {
    return true;
  }
  if (input.buyerVerificationStatus === "AEKOVERA_VETTED") {
    return true;
  }
  return input.buyerDeliveredOrders >= VERIFIED_BUYER_DELIVERED_ORDERS;
}
