"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";

/**
 * Password reset, in two steps on one page.
 *
 * Step one deliberately gives the SAME response whether or not the address has
 * an account, and the UI must not undo that by behaving differently. So the
 * form always advances to step two: a page that stopped and said "no account
 * found" would be a free way to check which email addresses gamble here.
 */

type Step = "REQUEST" | "RESET";

export function ResetForm() {
  const [step, setStep] = useState<Step>("REQUEST");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < 10;

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await response.json();
      // Only present when no email provider is configured — local development.
      if (body.devCode) setNote(`Development mode — your code is ${body.devCode}`);
      // Advances regardless. See the note above.
      setStep("RESET");
    } catch {
      setError("Network problem. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code, newPassword }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "That code is not valid.");
        return;
      }
      setDone(true);
    } catch {
      setError("Network problem — nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="card form-card">
        <p className="notice ok">
          Your password has been reset and every device has been signed out.
        </p>
        <button
          type="button"
          className="place"
          onClick={() => signIn("credentials", { email, callbackUrl: "/sports" })}
        >
          Sign in
        </button>
      </section>
    );
  }

  return (
    <section className="card form-card">
      {step === "REQUEST" ? (
        <form onSubmit={requestCode}>
          <label className="field">
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="hint">We will send a 6-digit code to this address.</span>
          </label>

          <button type="submit" className="place" disabled={busy || !email}>
            {busy ? "Sending…" : "Send reset code"}
          </button>
        </form>
      ) : (
        <form onSubmit={submitReset}>
          <p className="muted small">
            If <strong>{email}</strong> has an account, a code is on its way. Enter it below.
          </p>

          <label className="field">
            Reset code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>

          <label className="field">
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <span className="hint">At least 10 characters.</span>
          </label>

          <label className="field">
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>

          {tooShort ? <p className="notice error">Use at least 10 characters.</p> : null}
          {mismatch ? <p className="notice error">Those passwords do not match.</p> : null}

          <button
            type="submit"
            className="place"
            disabled={busy || code.length !== 6 || mismatch || tooShort || !newPassword}
          >
            {busy ? "Resetting…" : "Reset password"}
          </button>

          <button
            type="button"
            className="link-button"
            onClick={() => {
              setStep("REQUEST");
              setCode("");
              setError(null);
              setNote(null);
            }}
          >
            Use a different email
          </button>
        </form>
      )}

      {note ? <p className="notice ok">{note}</p> : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="muted small legal">
        Remembered it? <Link href="/api/auth/signin">Sign in</Link> instead.
      </p>
    </section>
  );
}
