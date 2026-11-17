"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";

/**
 * Password reset, in two steps on one page.
 *
 * Step one deliberately gives the SAME response whether or not the address has
 * an account, and the UI must not undo that by behaving differently. So the
 * form always advances to step two: a page that stopped and said "no account
 * found" would be a free way to check which email addresses gamble here.
 *
 * FIXED IN THE REDESIGN: the success screen used to offer a "Sign in" button
 * that called `signIn("credentials", { email })` with no password. That call
 * can only ever fail — the credentials schema requires a password — so the
 * button bounced the customer to an error at the exact moment they had just
 * succeeded. It is now a link to the sign-in form, with the email carried
 * across for them to type their new password against.
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
      <div className="sb-stack-3">
        <p className="sb-note sb-note--ok" role="status">
          <CheckCircle2 size={15} aria-hidden="true" />
          Your password has been reset and every device has been signed out.
        </p>
        <Link href="/signin" className="sb-btn sb-btn--primary sb-btn--lg">
          Sign in with your new password
        </Link>
      </div>
    );
  }

  return (
    <>
      {step === "REQUEST" ? (
        <form onSubmit={requestCode} noValidate>
          <label className="sb-field" htmlFor="reset-email">
            <span className="sb-field__label">Email</span>
            <input
              id="reset-email"
              className="sb-input"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="sb-hint">We will send a 6-digit code to this address.</span>
          </label>

          <button type="submit" className="sb-btn sb-btn--primary sb-btn--lg" disabled={busy || !email}>
            {busy ? (
              <>
                <Loader2 size={16} className="sb-spin" aria-hidden="true" /> Sending
              </>
            ) : (
              "Send reset code"
            )}
          </button>
        </form>
      ) : (
        <form onSubmit={submitReset} noValidate>
          <p className="sb-small sb-muted" style={{ marginTop: 0 }}>
            If <strong>{email}</strong> has an account, a code is on its way. Enter it below.
          </p>

          <label className="sb-field" htmlFor="reset-code">
            <span className="sb-field__label">Reset code</span>
            <input
              id="reset-code"
              className="sb-input sb-otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>

          <label className="sb-field" htmlFor="reset-new">
            <span className="sb-field__label">New password</span>
            <input
              id="reset-new"
              className="sb-input"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              aria-invalid={tooShort}
            />
            <span className="sb-hint">At least 10 characters.</span>
          </label>

          <label className="sb-field" htmlFor="reset-confirm">
            <span className="sb-field__label">Confirm new password</span>
            <input
              id="reset-confirm"
              className="sb-input"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              aria-invalid={mismatch}
            />
          </label>

          {tooShort ? (
            <p className="sb-note sb-note--error">
              <AlertTriangle size={14} aria-hidden="true" /> Use at least 10 characters.
            </p>
          ) : null}
          {mismatch ? (
            <p className="sb-note sb-note--error">
              <AlertTriangle size={14} aria-hidden="true" /> Those passwords do not match.
            </p>
          ) : null}

          <button
            type="submit"
            className="sb-btn sb-btn--primary sb-btn--lg"
            disabled={busy || code.length !== 6 || mismatch || tooShort || !newPassword}
          >
            {busy ? (
              <>
                <Loader2 size={16} className="sb-spin" aria-hidden="true" /> Resetting
              </>
            ) : (
              "Reset password"
            )}
          </button>

          <button
            type="button"
            className="sb-btn sb-btn--ghost"
            style={{ width: "100%", marginTop: "var(--sb-2)" }}
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

      {note ? (
        <p className="sb-note sb-note--warn" role="status">
          <Info size={14} aria-hidden="true" />
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="sb-note sb-note--error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </>
  );
}
