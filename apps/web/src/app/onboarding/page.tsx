import {
  ONBOARDING_STEP_LABELS,
  ONBOARDING_STEPS,
  PermissionDeniedError,
  onboardingProgress,
} from "@packsource/core";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { orgScopedRepository } from "@/lib/org-scoped";
import {
  CertificationsStep,
  CompanyStep,
  EquipmentStep,
  PaymentsStep,
  PlantsStep,
  TermsStep,
  SubmittedPanel,
} from "./step-forms";

/**
 * The resumable six-step supplier onboarding wizard. Progress is derived
 * from persisted domain state (profile, plants, certifications, …) on every
 * load — there is no separate wizard-state table to drift — so a supplier
 * who leaves mid-wizard resumes exactly where they stopped. Nothing here is
 * publicly readable: the page requires a session, and the publishing gate in
 * packages/core keeps draft profiles invisible marketplace-wide.
 */
export default async function OnboardingPage() {
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const repo = await orgScopedRepository();
  if (!repo) {
    redirect("/sign-in");
  }

  let snapshot;
  try {
    snapshot = await repo.snapshot();
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return (
        <main className="mx-auto max-w-lg px-4 py-16 text-center" data-testid="not-supplier">
          <h1 className="text-xl font-semibold">Supplier onboarding</h1>
          <p className="mt-2 text-sm text-neutral-600">
            This wizard is for supplier accounts. Your organization can browse the
            marketplace and send RFQs instead.
          </p>
        </main>
      );
    }
    throw error;
  }

  const [plants, certifications, equipment, capabilities, org] = await Promise.all([
    repo.plants(),
    repo.certifications(),
    repo.equipment(),
    repo.capabilities(),
    repo.organization(),
  ]);
  const progress = onboardingProgress(snapshot);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Supplier onboarding — {snapshot.org.name}</h1>

      <ol className="my-6 space-y-1 text-sm" data-testid="wizard-rail">
        {ONBOARDING_STEPS.map((step) => {
          const state = progress.steps.find((s) => s.step === step);
          return (
            <li key={step} data-testid={`rail-${step}`}>
              {state?.complete ? "✓" : progress.isSubmitted ? "–" : "○"}{" "}
              {ONBOARDING_STEP_LABELS[step]}
            </li>
          );
        })}
      </ol>

      {progress.isSubmitted ? (
        <SubmittedPanel />
      ) : (
        (() => {
          switch (progress.firstIncomplete ?? "payments") {
            case "company":
              return (
                <CompanyStep
                  initialAbout={snapshot.profile?.about ?? ""}
                  initialBillingEmail={org?.billingEmail ?? ""}
                />
              );
            case "plants":
              return (
                <PlantsStep
                  plants={plants.map((p) => ({
                    id: p.id,
                    name: p.name,
                    city: p.city,
                    country: p.country,
                  }))}
                />
              );
            case "certifications":
              return (
                <CertificationsStep
                  certifications={certifications.map((c) => ({
                    id: c.id,
                    type: c.type,
                    number: c.number,
                    evidenceFileId: c.evidenceFileId,
                  }))}
                />
              );
            case "equipment":
              return (
                <EquipmentStep
                  equipment={equipment.map((e) => ({
                    id: e.id,
                    kind: e.kind,
                    make: e.make,
                    model: e.model,
                  }))}
                  capabilities={capabilities.map((c) => ({ id: c.id, name: c.name }))}
                />
              );
            case "terms":
              return (
                <TermsStep
                  initialMinOrderDollars={
                    snapshot.profile?.minOrderValueCents != null
                      ? (snapshot.profile.minOrderValueCents / 100).toString()
                      : ""
                  }
                  initialPaymentTerms={snapshot.profile?.paymentTerms ?? "NET_30"}
                />
              );
            default:
              return (
                <PaymentsStep linkedAccountId={snapshot.profile?.stripeConnectAccountId ?? null} />
              );
          }
        })()
      )}
    </main>
  );
}
