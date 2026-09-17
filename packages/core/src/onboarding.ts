/**
 * Supplier onboarding wizard — pure state rules (spec: Feature Surface,
 * supplier console). Six steps with resumable state:
 *
 *   company details → plants & locations → certifications with document
 *   upload → equipment & capabilities → MOQ and payment terms → Stripe
 *   Connect account link
 *
 * Progress is *derived* from what the wizard has already persisted, not from
 * a client-side pointer: each step writes its rows as they are completed, so
 * a supplier who leaves and comes back resumes exactly where the data says
 * they are. Nothing is publicly visible until the profile is submitted for
 * review (see isPubliclyVisible).
 */

/** Wizard steps in display order. */
export const ONBOARDING_STEPS = [
  "company",
  "plants",
  "certifications",
  "equipment",
  "terms",
  "payments",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  company: "Company details",
  plants: "Plants & locations",
  certifications: "Certifications",
  equipment: "Equipment & capabilities",
  terms: "MOQ & payment terms",
  payments: "Stripe Connect account",
};

/** Everything the progress rules need, read through the org-scoped repository. */
export interface OnboardingSnapshot {
  org: { name: string };
  profile: {
    about: string | null;
    minOrderValueCents: number | null;
    paymentTerms: string | null;
    stripeConnectAccountId: string | null;
    submittedForReviewAt: Date | null;
  } | null;
  counts: {
    plants: number;
    certifications: number;
    equipment: number;
    capabilities: number;
  };
}

export interface StepState {
  step: OnboardingStep;
  label: string;
  complete: boolean;
}

export interface OnboardingProgress {
  /** Every step, in wizard order, with its derived completion state. */
  steps: readonly StepState[];
  /** First unfinished step — where a resuming supplier lands. Null once complete. */
  firstIncomplete: OnboardingStep | null;
  /** All six steps done — submission to the review queue becomes possible. */
  isComplete: boolean;
  /** The profile has been handed to Aekovera's review queue. */
  isSubmitted: boolean;
}

function nonEmpty(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value.trim().length > 0;
}

function stepComplete(step: OnboardingStep, snapshot: OnboardingSnapshot): boolean {
  const { profile, counts } = snapshot;
  switch (step) {
    // The organization row is created at sign-up with a name; the step's own
    // content is the public description.
    case "company":
      return profile !== null && nonEmpty(profile.about);
    case "plants":
      return counts.plants > 0;
    case "certifications":
      return counts.certifications > 0;
    // The step covers both surfaces; a supplier lists at least one of each.
    case "equipment":
      return counts.equipment > 0 && counts.capabilities > 0;
    case "terms":
      return (
        profile !== null &&
        profile.minOrderValueCents !== null &&
        profile.minOrderValueCents > 0 &&
        nonEmpty(profile.paymentTerms)
      );
    case "payments":
      return profile !== null && nonEmpty(profile.stripeConnectAccountId);
  }
}

/** Derive resumable wizard progress from persisted state. */
export function onboardingProgress(snapshot: OnboardingSnapshot): OnboardingProgress {
  const steps: StepState[] = ONBOARDING_STEPS.map((step) => ({
    step,
    label: ONBOARDING_STEP_LABELS[step],
    complete: stepComplete(step, snapshot),
  }));
  const firstIncomplete = steps.find((s) => !s.complete)?.step ?? null;
  return {
    steps,
    firstIncomplete,
    isComplete: firstIncomplete === null,
    isSubmitted: snapshot.profile !== null && snapshot.profile.submittedForReviewAt !== null,
  };
}

/**
 * The publishing gate (spec: "nothing is publicly visible until the profile
 * is submitted for review"). The marketplace, search index, and public API
 * read supplier profiles through the repository functions that consult this
 * rule — a draft profile is invisible outside its own org and the staff
 * verification queue.
 */
export function isPubliclyVisible(profile: {
  submittedForReviewAt: Date | null;
}): boolean {
  return profile.submittedForReviewAt !== null;
}
