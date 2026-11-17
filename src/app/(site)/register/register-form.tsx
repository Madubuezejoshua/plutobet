"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { AlertTriangle, ArrowLeft, Eye, EyeOff, Info, Loader2 } from "lucide-react";
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
 *
 * WHAT THE REDESIGN CHANGED: the markup, and only the markup. Every request,
 * payload, field name, validation attribute and error path is the same as
 * before. A visual pass over a registration form is exactly the wrong place to
 * quietly relax a rule.
 */

type Step = "DETAILS" | "VERIFY";

export function RegisterForm({ referralCode }: { referralCode?: string }) {
  const [step, setStep] = useState<Step>("DETAILS");
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
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
    <>
      <ol className="sb-steps" aria-label={`Step ${step === "DETAILS" ? 1 : 2} of 2`}>
        <li className="sb-steps__dot" data-on="true" aria-hidden="true">1</li>
        <li style={{ color: step === "DETAILS" ? "var(--sb-ink)" : undefined }}>Your details</li>
        <li className="sb-steps__line" aria-hidden="true" />
        <li className="sb-steps__dot" data-on={step === "VERIFY"} aria-hidden="true">2</li>
        <li style={{ color: step === "VERIFY" ? "var(--sb-ink)" : undefined }}>Verify phone</li>
      </ol>

      {step === "DETAILS" ? (
        <form onSubmit={sendCode} noValidate>
          <label className="sb-field" htmlFor="reg-email">
            <span className="sb-field__label">Email</span>
            <input
              id="reg-email"
              className="sb-input"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="sb-field" htmlFor="reg-phone">
            <span className="sb-field__label">Phone number</span>
            <input
              id="reg-phone"
              className="sb-input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              placeholder="0803 123 4567"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
            <span className="sb-hint">We will text you a 6-digit code.</span>
          </label>

          <label className="sb-field" htmlFor="reg-dob">
            <span className="sb-field__label">Date of birth</span>
            <input
              id="reg-dob"
              className="sb-input"
              type="date"
              autoComplete="bday"
              required
              max={maxBirthDate}
              min="1900-01-01"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
            />
            <span className="sb-hint">You must be 18 or over. We verify this.</span>
          </label>

          <div className="sb-grid2">
            <label className="sb-field" htmlFor="reg-first">
              <span className="sb-field__label">
                First name <span className="sb-field__optional">Optional</span>
              </span>
              <input
                id="reg-first"
                className="sb-input"
                autoComplete="given-name"
                maxLength={80}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </label>

            <label className="sb-field" htmlFor="reg-last">
              <span className="sb-field__label">
                Last name <span className="sb-field__optional">Optional</span>
              </span>
              <input
                id="reg-last"
                className="sb-input"
                autoComplete="family-name"
                maxLength={80}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </label>
          </div>

          <label className="sb-field" htmlFor="reg-username">
            <span className="sb-field__label">
              Username <span className="sb-field__optional">Optional</span>
            </span>
            <input
              id="reg-username"
              className="sb-input"
              autoComplete="username"
              maxLength={20}
              pattern="[A-Za-z0-9_]{3,20}"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <span className="sb-hint">3-20 letters, numbers or underscore.</span>
          </label>

          <label className="sb-field" htmlFor="reg-password">
            <span className="sb-field__label">Password</span>
            <span className="sb-inputwrap">
              <input
                id="reg-password"
                className="sb-input"
                type={reveal ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
            <span className="sb-hint">At least 10 characters. Length beats complexity.</span>
          </label>

          {referralCode ? (
            <p className="sb-note sb-note--ok">
              <Info size={14} aria-hidden="true" />
              Referral code <strong>{referralCode}</strong> will be applied.
            </p>
          ) : null}

          <button
            type="submit"
            className="sb-btn sb-btn--primary sb-btn--lg"
            disabled={busy || !dateOfBirth}
          >
            {busy ? (
              <>
                <Loader2 size={16} className="sb-spin" aria-hidden="true" /> Sending
              </>
            ) : (
              "Send code"
            )}
          </button>
        </form>
      ) : (
        <form onSubmit={createAccount} noValidate>
          <p className="sb-small sb-muted" style={{ marginTop: 0 }}>
            Enter the code sent to <strong>{phoneNumber}</strong>.
          </p>

          <label className="sb-field" htmlFor="reg-otp">
            <span className="sb-field__label">Verification code</span>
            <input
              id="reg-otp"
              className="sb-input sb-otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="\d{6}"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            />
          </label>

          <button
            type="submit"
            className="sb-btn sb-btn--primary sb-btn--lg"
            disabled={busy || otp.length !== 6}
          >
            {busy ? (
              <>
                <Loader2 size={16} className="sb-spin" aria-hidden="true" /> Creating account
              </>
            ) : (
              "Create account"
            )}
          </button>

          <button
            type="button"
            className="sb-btn sb-btn--ghost"
            style={{ width: "100%", marginTop: "var(--sb-2)" }}
            onClick={() => {
              setStep("DETAILS");
              setOtp("");
              setError(null);
            }}
          >
            <ArrowLeft size={15} aria-hidden="true" /> Change details
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

      <p className="sb-legal">
        By creating an account you confirm you are 18 or over. Betting can be addictive — you can
        set deposit, loss and wager limits, or <Link href="/responsible">self-exclude</Link>, at any
        time from your account.
      </p>
    </>
  );
}
