"use client";

import { useState } from "react";
import { naira } from "@/lib/money";

/**
 * Safer gambling controls.
 *
 * Two deliberate pieces of friction, both of which exist because the person
 * using this page may be the person least able to protect themselves in the
 * moment:
 *
 *  - a raised limit is shown as scheduled, not applied, with the date it
 *    takes effect;
 *  - self-exclusion requires typing a confirmation phrase, because it cannot
 *    be undone from here and a mis-tap should not close someone's account.
 */

interface ActiveLimit {
  type: string;
  periodDays: number;
  amountMinor: string;
  effectiveFrom: string;
}

const LIMIT_TYPES = [
  { key: "DEPOSIT", label: "Deposit limit", blurb: "The most you can pay in." },
  { key: "LOSS", label: "Loss limit", blurb: "Net losses, after anything you win back." },
  { key: "WAGER", label: "Wager limit", blurb: "Total staked, win or lose." },
] as const;

const PERIODS = [
  { days: 1, label: "per day" },
  { days: 7, label: "per week" },
  { days: 30, label: "per month" },
] as const;


export function ResponsibleControls(props: {
  limits: ActiveLimit[];
  coolOffUntil: string | null;
  status: string;
}) {
  const [type, setType] = useState<string>("DEPOSIT");
  const [periodDays, setPeriodDays] = useState(1);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmPhrase, setConfirmPhrase] = useState("");

  const excluded = props.status === "SELF_EXCLUDED";
  const coolingOff = props.coolOffUntil && new Date(props.coolOffUntil) > new Date();

  async function post(body: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/responsible", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ kind: "error", text: payload.message ?? "That could not be saved." });
        return null;
      }
      return payload;
    } catch {
      setMessage({ kind: "error", text: "Network problem — nothing was changed." });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveLimit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const amountMinor = BigInt(Math.round(parsed * 100)).toString();

    const result = await post({ action: "SET_LIMIT", type, periodDays, amountMinor });
    if (!result) return;

    setMessage({
      kind: "ok",
      text: result.deferred
        ? // Never let a player believe a raised ceiling is live when it is not.
          `Increase scheduled. It takes effect on ${new Date(result.effectiveFrom).toLocaleString("en-NG")} — your current limit still applies until then.`
        : "Limit updated. It applies immediately.",
    });
    setAmount("");
  }

  async function startCoolOff(days: number) {
    const result = await post({ action: "COOL_OFF", days });
    if (result) window.location.reload();
  }

  async function selfExclude(months?: number) {
    if (confirmPhrase.trim().toUpperCase() !== "SELF EXCLUDE") {
      setMessage({ kind: "error", text: 'Type "SELF EXCLUDE" to confirm.' });
      return;
    }
    const result = await post({ action: "SELF_EXCLUDE", ...(months ? { months } : {}) });
    /*
     * A FULL document navigation, deliberately.
     *
     * `/api/auth/signout` is a route handler, not a page: it clears the session
     * cookie and issues its own redirect. `useRouter().push()` — which the lint
     * rule below suggests — performs a client-side transition that never gives
     * the browser a response to act on, so the cookie would survive and the
     * user would stay signed in after asking to be excluded. That is the one
     * outcome this button must never produce.
     */
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (result) window.location.assign("/api/auth/signout");
  }

  if (excluded) {
    return (
      <section className="sb-panel sb-pad">
        <h2>Your account is self-excluded</h2>
        <p className="sb-small sb-muted">
          You cannot bet or deposit. This applies to your verified identity, so it also covers any
          new account you might open.
        </p>
        <p className="sb-legal">
          Reinstatement is not automatic and cannot be requested here. If you need support,
          Gamblers Anonymous Nigeria and similar services can help.
        </p>
      </section>
    );
  }

  return (
    <>
      {coolingOff ? (
        <section className="sb-panel sb-pad">
          <p className="sb-note sb-note--ok">
            You are taking a break until{" "}
            {new Date(props.coolOffUntil!).toLocaleString("en-NG")}. Betting and deposits are
            paused. A break cannot be shortened once it starts.
          </p>
        </section>
      ) : null}

      <section className="sb-panel sb-pad">
        <h2>Your limits</h2>
        {props.limits.length === 0 ? (
          <p className="sb-small sb-muted">You have not set any limits yet.</p>
        ) : (
          <ul className="sb-stack">
            {props.limits.map((limit) => {
              const pending = new Date(limit.effectiveFrom) > new Date();
              return (
                <li key={`${limit.type}-${limit.periodDays}`}>
                  <div>
                    <strong>{naira(limit.amountMinor)}</strong>
                    <span className="sb-small sb-muted">
                      {" "}
                      {limit.type.toLowerCase()}{" "}
                      {PERIODS.find((p) => p.days === limit.periodDays)?.label}
                    </span>
                  </div>
                  {pending ? (
                    <span className="sb-pill sb-pill--void">
                      from {new Date(limit.effectiveFrom).toLocaleDateString("en-NG")}
                    </span>
                  ) : (
                    <span className="sb-pill">active</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={saveLimit}>
          <label className="sb-field">
            <span className="sb-field__label">Limit type</span>
            <select className="sb-input" value={type} onChange={(e) => setType(e.target.value)}>
              {LIMIT_TYPES.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="sb-hint">
              {LIMIT_TYPES.find((option) => option.key === type)?.blurb}
            </span>
          </label>

          <label className="sb-field">
            <span className="sb-field__label">Period</span>
            <select className="sb-input" value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))}>
              {PERIODS.map((period) => (
                <option key={period.days} value={period.days}>
                  {period.label}
                </option>
              ))}
            </select>
          </label>

          <label className="sb-field">
            <span className="sb-field__label">Amount (₦)</span>
            <input className="sb-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <span className="sb-hint">
              Lowering a limit applies at once. Raising one takes 24 hours.
            </span>
          </label>

          <button type="submit" className="sb-btn sb-btn--primary sb-btn--lg" disabled={busy || amount === ""}>
            {busy ? "Saving…" : "Save limit"}
          </button>
        </form>
      </section>

      <section className="sb-panel sb-pad">
        <h2>Take a break</h2>
        <p className="sb-small sb-muted">
          Pauses betting and deposits. It cannot be shortened once it starts.
        </p>
        <div className="sb-chips" style={{ padding: 0 }}>
          {[1, 7, 30, 90].map((days) => (
            <button
              key={days}
              type="button"
              className="sb-chip"
              disabled={busy}
              onClick={() => startCoolOff(days)}
            >
              <span className="sb-bold">{days}</span>
              <span className="sb-xs sb-muted">{days === 1 ? "day" : "days"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="sb-panel sb-pad">
        <h2>Self-exclude</h2>
        <p className="sb-small sb-muted">
          Closes your account. This is registered against your verified identity, so it also
          covers any new account you open. It cannot be undone here.
        </p>

        <label className="sb-field">
          <span className="sb-field__label">Type SELF EXCLUDE to confirm</span>
          <input className="sb-input" value={confirmPhrase} onChange={(e) => setConfirmPhrase(e.target.value)} />
        </label>

        <div className="sb-chips" style={{ padding: 0 }}>
          {[
            { months: 6, label: "6 months" },
            { months: 12, label: "1 year" },
            { months: 60, label: "5 years" },
          ].map((option) => (
            <button
              key={option.months}
              type="button"
              className="sb-chip"
              disabled={busy}
              onClick={() => selfExclude(option.months)}
            >
              <span className="sb-bold">{option.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="sb-btn sb-btn--ghost"
          disabled={busy}
          onClick={() => selfExclude()}
        >
          Exclude permanently
        </button>
      </section>

      {message ? (
        <p className={message.kind === "ok" ? "notice ok" : "notice error"} role="status">
          {message.text}
        </p>
      ) : null}
    </>
  );
}
