"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { latestEligibleBirthDate } from "@/modules/users/age";

/**
 * The write-once date-of-birth form.
 *
 * The `max` attribute is a courtesy that stops an underage visitor filling in
 * the rest before being told. It is not the control: the service refuses, and
 * the database trigger refuses again on write. The browser check is the one
 * that matters least and is trivially bypassed.
 *
 * `latestEligibleBirthDate` is computed per render rather than pinned in state,
 * so a page left open across midnight does not offer a cutoff that is a day
 * stale.
 */

export function DateOfBirthForm() {
  const router = useRouter();
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxBirthDate = latestEligibleBirthDate();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || dateOfBirth === "") return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/account/date-of-birth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dateOfBirth }),
      });
      const body = (await response.json().catch(() => null)) as
        | { completed?: boolean; message?: string }
        | null;

      if (!response.ok || !body?.completed) {
        setError(
          body?.message ??
            "We could not record that. Check the date and try again.",
        );
        return;
      }

      // The banner in the shell, the account page and every gated route all
      // change. Let the server re-render rather than patching state here.
      router.push("/account");
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <label className="sb-field" htmlFor="dob">
        <span className="sb-field__label">Date of birth</span>
        <input
          id="dob"
          className="sb-input"
          type="date"
          autoComplete="bday"
          required
          max={maxBirthDate}
          min="1900-01-01"
          value={dateOfBirth}
          onChange={(event) => setDateOfBirth(event.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? "dob-error" : undefined}
        />
        <span className="sb-hint">You must be 18 or over. We verify this.</span>
      </label>

      {error ? (
        <p id="dob-error" className="sb-note sb-note--error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="sb-btn sb-btn--primary sb-btn--lg"
        disabled={busy || dateOfBirth === ""}
      >
        {busy ? (
          <>
            <Loader2 size={16} className="sb-spin" aria-hidden="true" /> Saving
          </>
        ) : (
          "Confirm and continue"
        )}
      </button>
    </form>
  );
}
