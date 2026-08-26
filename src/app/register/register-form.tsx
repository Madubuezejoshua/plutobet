"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

/**
 * Two-step signup: prove the phone, then create the account.
 *
 * The phone is verified BEFORE the account exists rather than after, so an
 * unverifiable number never becomes a registered user. It also means the OTP
 * throttles apply to signup itself, which is the surface a bot uses to
 * mass-create accounts for bonus abuse.
 */

type Step = "DETAILS" | "VERIFY";

export function RegisterForm() {
  const [step, setStep] = useState<Step>("DETAILS");
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber, purpose: "PHONE_VERIFY" }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "Could not send a code. Try again shortly.");
        return;
      }
      // Only present when no SMS provider is configured — local development.
      if (body.devCode) setNote(`Development mode — your code is ${body.devCode}`);
      setStep("VERIFY");
    } catch {
      setError("Network problem. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, phoneNumber, otp }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "Could not create your account.");
        return;
      }

      // Sign in through the ordinary credentials flow rather than minting a
      // session here: one code path issues sessions, so there is one place
      // suspension and self-exclusion are enforced.
      await signIn("credentials", { email, password, callbackUrl: "/sports" });
    } catch {
      setError("Network problem. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card form-card">
      {step === "DETAILS" ? (
        <form onSubmit={sendCode}>
          <label className="field">
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="field">
            Phone number
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              placeholder="0803 123 4567"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
            <span className="hint">We will text you a 6-digit code.</span>
          </label>

          <label className="field">
            Password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="hint">At least 10 characters. Length beats complexity.</span>
          </label>

          <button type="submit" className="place" disabled={busy}>
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form onSubmit={createAccount}>
          <p className="muted small">
            Enter the code sent to <strong>{phoneNumber}</strong>.
          </p>

          <label className="field">
            Verification code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="\d{6}"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            />
          </label>

          <button type="submit" className="place" disabled={busy || otp.length !== 6}>
            {busy ? "Creating…" : "Create account"}
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setStep("DETAILS");
              setOtp("");
              setError(null);
            }}
          >
            Change details
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
        By creating an account you confirm you are 18 or over. Betting can be addictive — you can
        set deposit, loss and wager limits, or self-exclude, at any time from your account.
      </p>
    </section>
  );
}
