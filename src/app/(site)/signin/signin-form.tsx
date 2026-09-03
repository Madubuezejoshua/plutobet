"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { AlertTriangle, Eye, EyeOff, Loader2 } from "lucide-react";

/**
 * The credentials form.
 *
 * `redirect: false` so a failure renders here instead of bouncing to a
 * framework error page and losing what the customer typed.
 *
 * ON ERROR WORDING. There is exactly one failure message for a bad email, a
 * bad password, a suspended account and a self-excluded account, because
 * `authorize()` deliberately returns the same `null` for all four. Writing a
 * more helpful message here would re-introduce the account-enumeration oracle
 * the server was careful to remove. A self-excluded customer is directed to
 * support rather than told their state on an unauthenticated page.
 */

const GENERIC = "That email and password combination was not recognised.";

function messageFor(code: string | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case "CredentialsSignin":
      return GENERIC;
    case "SessionRequired":
      return "Please sign in to continue.";
    default:
      // Configuration/OAuth codes: say something true without echoing the code.
      return "Sign-in is temporarily unavailable. Please try again shortly.";
  }
}

export function SignInForm({
  callbackUrl,
  initialError,
}: {
  callbackUrl: string;
  initialError?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(messageFor(initialError));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signIn("credentials", {
        email,
        password,
        // Recorded against the session row for "your devices". Display only.
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent.slice(0, 400),
        redirect: false,
        callbackUrl,
      });

      if (!result || result.error) {
        setError(messageFor(result?.error ?? "CredentialsSignin") ?? GENERIC);
        setPassword("");
        return;
      }

      // `result.url` is produced by NextAuth from our own callbackUrl, which
      // was already restricted to a same-site path on the server.
      router.push(result.url ?? callbackUrl);
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <label className="sb-field" htmlFor="signin-email">
        <span className="sb-field__label">Email</span>
        <input
          id="signin-email"
          className="sb-input"
          type="email"
          name="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={320}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error !== null}
        />
      </label>

      {/*
        The "Forgot password?" link is a SIBLING of the label, not inside it.
        Nested, its text became part of the field's accessible name — a screen
        reader announced "Password Forgot password?, edit text" — and clicking
        the link inside a label is ambiguous: the browser may focus the input
        instead of following it. Found by a browser test that could not locate a
        field labelled exactly "Password".
      */}
      <div className="sb-field">
        <div className="sb-field__label">
          <label htmlFor="signin-password">Password</label>
          <Link href="/forgot-password" className="sb-field__optional">
            Forgot password?
          </Link>
        </div>
        <span className="sb-inputwrap">
          <input
            id="signin-password"
            className="sb-input"
            type={reveal ? "text" : "password"}
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error !== null}
            aria-describedby={error ? "signin-error" : undefined}
          />
          <button
            type="button"
            className="sb-reveal"
            onClick={() => setReveal((r) => !r)}
            aria-pressed={reveal}
            aria-label={reveal ? "Hide password" : "Show password"}
          >
            {reveal ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        </span>
      </div>

      {error ? (
        <p id="signin-error" className="sb-note sb-note--error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="sb-btn sb-btn--primary sb-btn--lg"
        disabled={busy || email.trim() === "" || password === ""}
      >
        {busy ? (
          <>
            <Loader2 size={16} className="sb-spin" aria-hidden="true" /> Signing in
          </>
        ) : (
          "Sign in"
        )}
      </button>
    </form>
  );
}
