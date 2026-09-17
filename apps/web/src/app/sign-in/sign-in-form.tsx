"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Two sign-in paths: request a magic link (delivered to the mock inbox in
 * dev) or email + password. Both hit the same Auth.js credentials provider.
 */
export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "magic">("magic");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");

  async function requestMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setStatus("sending");
    const response = await fetch("/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setStatus(response.ok ? "sent" : "idle");
  }

  async function signInWithPassword(event: React.FormEvent) {
    event.preventDefault();
    // next-auth/react's signIn handles the CSRF token exchange and session
    // cookie; a raw fetch to the callback endpoint would be rejected.
    const result = await signIn("credentials", { email, password, redirect: false });
    if (result && !result.error) {
      router.refresh();
      router.push("/");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode("magic")}
          className={mode === "magic" ? "font-semibold underline" : "text-neutral-500"}
        >
          Email link
        </button>
        <button
          type="button"
          onClick={() => setMode("password")}
          className={mode === "password" ? "font-semibold underline" : "text-neutral-500"}
        >
          Password
        </button>
      </div>

      {mode === "magic" ? (
        <form onSubmit={requestMagicLink} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            data-testid="magic-email"
          />
          <button
            type="submit"
            disabled={status === "sending"}
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            data-testid="magic-submit"
          >
            {status === "sent"
              ? "Link sent — check the mock inbox (/api/dev/inbox)"
              : status === "sending"
                ? "Sending…"
                : "Send magic link"}
          </button>
        </form>
      ) : (
        <form onSubmit={signInWithPassword} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            data-testid="password-email"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            data-testid="password-field"
          />
          <button
            type="submit"
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white"
            data-testid="password-submit"
          >
            Sign in
          </button>
        </form>
      )}
    </div>
  );
}
