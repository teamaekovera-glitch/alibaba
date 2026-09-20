import { verificationLabel } from "@/lib/format";

/**
 * Verification-tier badge (spec: trust tiers Unverified → Verified →
 * Aekovera-Vetted). Color encodes the tier; the label spells it out for
 * color-blind readers and screen readers alike.
 */
const TIER_CLASSES: Record<string, string> = {
  AEKOVERA_VETTED: "border-brand-600 bg-brand-600 text-white",
  VERIFIED: "border-brand-200 bg-brand-50 text-brand-700",
  UNVERIFIED: "border-neutral-200 bg-neutral-50 text-neutral-600",
};

export function VerificationBadge({ tier }: { tier: string }) {
  const className = TIER_CLASSES[tier] ?? TIER_CLASSES.UNVERIFIED;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
      data-testid={`verification-tier-${tier}`}
    >
      {verificationLabel(tier)}
    </span>
  );
}
