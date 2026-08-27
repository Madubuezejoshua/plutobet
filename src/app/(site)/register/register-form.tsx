"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { latestEligibleBirthDate } from "@/modules/users/age";

/**
 * Two-step signup: prove the phone, then create the account.
 *
 * The phone is verified BEFORE the account exists rather than after, so an
 * unverifiable number never becomes a registered user. It also means the OTP
 * throttles apply to signup itself, which is the surface a bot uses to
 * mass-create accounts for bonus abuse.
 *
 * Date of birth is collected in step one and enforced in three places: the
 * `max` attribute below (a courtesy), the registration service (a clear
 * refusal), and a database trigger (the control that actually counts). The
 * browser check is the one that matters least — it is trivially bypassed, and
 * is here only so an underage visitor is told before filling in the rest.
 */

type Step = "DETAILS" | "VERIFY";

export function RegisterForm({ referralCode }: { referralCode?: string }) {
  const [step, setStep] = useState<Step>("DETAILS");
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Computed once per render rather than pinned in state: a session left open
  // across midnight would otherwise offer a cutoff that is a day stale.
  const maxBirthDate = latestEligibleBirthDate();

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
        body: JSON.stringify({
          email,
          password,
          phoneNumber,
          otp,
          dateOfBirth,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          username: username.trim() || undefined,
          referredByCode: referralCode || undefined,
        }),
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
            Date of birth
            <input
              type="date"
              autoComplete="bday"
              required
              max={maxBirthDate}
              min="1900-01-01"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
            />
            <span className="hint">You must be 18 or over. We verify this.</span>
          </label>

          <label className="field">
            First name <span className="hint">Optional</span>
            <input
              autoComplete="given-name"
              maxLength={80}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </label>

          <label className="field">
            Last name <span className="hint">Optional</span>
            <input
              autoComplete="family-name"
              maxLength={80}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </label>

          <label className="field">
            Username <span className="hint">Optional</span>
            <input
              autoComplete="username"
              maxLength={20}
              pattern="[A-Za-z0-9_]{3,20}"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <span className="hint">3-20 letters, numbers or underscore.</span>
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

          {referralCode ? (
            <p className="notice info">
              Referral code <strong>{referralCode}</strong> will be applied.
            </p>
          ) : null}

          <button type="submit" className="place" disabled={busy || !dateOfBirth}>
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
