import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const signedIn = await auth();
  if (signedIn) {
    redirect("/");
  }
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <h1 className="mb-2 text-2xl font-semibold">Sign in to PackSource</h1>
      <p className="mb-8 text-sm text-neutral-600">
        Suppliers and buyers sign in with an email link or a password.
      </p>
      {error ? (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error === "invalid_link"
            ? "That sign-in link is invalid or has expired — request a new one."
            : "Sign-in failed. Try again."}
        </p>
      ) : null}
      <SignInForm />
    </main>
  );
}
