"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PreferencesView } from "@/modules/users/profile.service";

const ODDS_FORMATS = [
  { value: "DECIMAL", label: "Decimal", example: "2.50" },
  { value: "FRACTIONAL", label: "Fractional", example: "3/2" },
  { value: "AMERICAN", label: "American", example: "+150" },
] as const;

/**
 * Preferences.
 *
 * Saved on change rather than behind a Save button — these are all reversible,
 * low-stakes toggles, and a form that silently discards a toggle because
 * someone navigated away is worse than an extra request.
 *
 * Odds format is stored but NOT yet applied to the odds board: the display
 * layer still renders decimals everywhere. That is stated on the page rather
 * than left for the user to discover.
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
      <section className="card form-card">
        <h2>Odds format</h2>
        <label className="field">
          How prices are shown
          <select
            value={prefs.oddsFormat}
            disabled={busy}
            onChange={(e) => save({ oddsFormat: e.target.value as PreferencesView["oddsFormat"] })}
          >
            {ODDS_FORMATS.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label} — {format.example}
              </option>
            ))}
          </select>
        </label>
        <p className="notice warn">
          Saved, but not applied yet: the odds board still shows decimal prices everywhere. Format
          conversion arrives with the odds engine work in phase 7.
        </p>
      </section>

      <section className="card form-card">
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

        {saved ? <p className="notice ok">Saved.</p> : null}
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <p className="muted small legal">
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
      className="field"
      style={{ display: "flex", alignItems: "flex-start", gap: 11, marginBottom: 14 }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0 }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span style={{ color: "var(--ink)", fontWeight: 600 }}>{label}</span>
        <br />
        <span className="hint">{hint}</span>
      </span>
    </label>
  );
}
