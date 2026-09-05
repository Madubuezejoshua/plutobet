"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PreferencesView } from "@/modules/users/profile.service";
import { formatOdds } from "@/modules/odds/format";

const ODDS_FORMATS = [
  { value: "DECIMAL", label: "Decimal" },
  { value: "FRACTIONAL", label: "Fractional" },
  { value: "AMERICAN", label: "American" },
] as const;

/*
 * The example is rendered by the SAME function the odds board uses, rather
 * than being a hard-coded string. A hard-coded "3/2" would keep claiming to be
 * right after a change to the conversion, which is precisely when a customer
 * would need it to be honest.
 */
const EXAMPLE_DECIMAL = 2.5;

const ODDS_CHANGE_POLICIES = [
  {
    value: "ASK",
    label: "Ask me every time",
    hint: "We stop and show you the old and new price before placing.",
  },
  {
    value: "HIGHER_ONLY",
    label: "Accept higher odds only",
    hint: "A price that moves in your favour is accepted; a worse one still asks.",
  },
  {
    value: "ANY",
    label: "Accept any change",
    hint: "Your bet is placed at whatever the price is when it reaches us.",
  },
] as const;

/**
 * Preferences.
 *
 * Saved on change rather than behind a Save button — these are all reversible,
 * low-stakes toggles, and a form that silently discards a toggle because
 * someone navigated away is worse than an extra request.
 *
 * Both odds settings are live: the format is applied across the board and the
 * slip, and the change policy is read at placement. Neither is cosmetic.
 */
export function PreferencesForm({ initial }: { initial: PreferencesView }) {
  const router = useRouter();
  const [prefs, setPrefs] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(patch: Partial<PreferencesView>) {
    const previous = prefs;
    // Applied locally first so the control responds immediately; rolled back
    // if the request fails, so the UI never shows a setting that did not save.
    setPrefs({ ...prefs, ...patch });
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch("/api/account/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await response.json();
      if (!response.ok) {
        setPrefs(previous);
        setError(body.message ?? "That preference could not be saved.");
        return;
      }
      setPrefs(body as PreferencesView);
      setSaved(true);
      router.refresh();
    } catch {
      setPrefs(previous);
      setError("Network problem — nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="sb-panel sb-pad">
        <h2>Odds format</h2>
        <label className="sb-field">
          <span className="sb-field__label">How prices are shown</span>
          <select className="sb-input"
            value={prefs.oddsFormat}
            disabled={busy}
            onChange={(e) => save({ oddsFormat: e.target.value as PreferencesView["oddsFormat"] })}
          >
            {ODDS_FORMATS.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label} — {formatOdds(EXAMPLE_DECIMAL, format.value)}
              </option>
            ))}
          </select>
        </label>
        <p className="sb-small sb-muted">
          Applied across the odds board and your bet slip. Prices are calculated in decimal
          internally whichever format you choose — the other two are lossy, and a bet settles
          against the exact price you accepted.
        </p>
      </section>

      <section className="sb-panel sb-pad">
        <h2>If the price changes</h2>
        <p className="sb-small sb-muted">
          Odds move between building a slip and confirming it. This decides what happens then.
        </p>

        {ODDS_CHANGE_POLICIES.map((policy) => (
          <label
            key={policy.value}
            className="sb-field"
            style={{ display: "flex", alignItems: "flex-start", gap: 11, marginBottom: 14 }}
          >
            <input className="sb-input"
              type="radio"
              name="oddsChangePolicy"
              checked={prefs.oddsChangePolicy === policy.value}
              disabled={busy}
              style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0 }}
              onChange={() => save({ oddsChangePolicy: policy.value })}
            />
            <span>
              <span style={{ color: "var(--sb-ink)", fontWeight: 600 }}>{policy.label}</span>
              <br />
              <span className="sb-hint">{policy.hint}</span>
            </span>
          </label>
        ))}

        <p className="sb-legal">
          A drifted price is never accepted on your behalf unless you chose one of the last two
          options here.
        </p>
      </section>

      <section className="sb-panel sb-pad">
        <h2>Notifications</h2>

        <Toggle
          label="Email"
          hint="Bet settlement, withdrawals, security alerts."
          checked={prefs.emailNotifications}
          disabled={busy}
          onChange={(value) => save({ emailNotifications: value })}
        />
        <Toggle
          label="SMS"
          hint="Verification codes are always sent regardless of this setting."
          checked={prefs.smsNotifications}
          disabled={busy}
          onChange={(value) => save({ smsNotifications: value })}
        />
        <Toggle
          label="Push"
          hint="Not available yet — no mobile app."
          checked={prefs.pushNotifications}
          disabled
          onChange={(value) => save({ pushNotifications: value })}
        />
        <Toggle
          label="Marketing emails"
          hint="Offers and promotions. Off unless you turn it on."
          checked={prefs.marketingEmails}
          disabled={busy}
          onChange={(value) => save({ marketingEmails: value })}
        />

        {saved ? <p className="sb-note sb-note--ok">Saved.</p> : null}
        {error ? (
          <p className="sb-note sb-note--error" role="alert">
            {error}
          </p>
        ) : null}

        <p className="sb-legal">
          Service messages about your money — deposits, withdrawals, settled bets — and security
          alerts are sent regardless of these settings. Turning notifications off does not turn
          those off.
        </p>
      </section>
    </>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className="sb-field"
      style={{ display: "flex", alignItems: "flex-start", gap: 11, marginBottom: 14 }}
    >
      <input className="sb-input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0 }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span style={{ color: "var(--sb-ink)", fontWeight: 600 }}>{label}</span>
        <br />
        <span className="sb-hint">{hint}</span>
      </span>
    </label>
  );
}
