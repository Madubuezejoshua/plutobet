"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

/**
 * Error boundary for player-facing pages.
 *
 * `global-error.tsx` is the catch-all, but it replaces the entire document —
 * including the navigation — so a reader lands somewhere with no way out but
 * the back button. The site layout does not read a session, which means the
 * chrome renders perfectly well even when a page inside it fails, so a
 * boundary here keeps people inside the app and able to go elsewhere.
 *
 * Saying that nothing moved is not reassurance-for-its-own-sake. On a betting
 * site the first thought on an error screen is "did my bet go through?", and
 * the honest answer is available: a page that failed to render never reached
 * placement, which is transactional and idempotent.
 */
export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="sb-page sb-page--narrow">
      <section className="sb-panel sb-pad">
        <AlertTriangle size={26} aria-hidden="true" style={{ color: "var(--sb-warn)" }} />
        <h1 style={{ margin: "var(--sb-3) 0 0", fontSize: 21, letterSpacing: "-0.02em" }}>
          This page didn’t load
        </h1>

        <p className="sb-muted" style={{ margin: "var(--sb-2) 0 0", lineHeight: 1.6 }}>
          Something failed on our side. Nothing was placed, paid or changed — your balance and
          any open bets are untouched.
        </p>

        <div style={{ display: "flex", gap: "var(--sb-2)", marginTop: "var(--sb-5)", flexWrap: "wrap" }}>
          <button type="button" onClick={reset} className="sb-btn sb-btn--primary">
            Try again
          </button>
          <Link href="/" className="sb-btn sb-btn--ghost">
            Go to home
          </Link>
          <Link href="/bets" className="sb-btn sb-btn--ghost">
            My bets
          </Link>
        </div>

        {error.digest ? (
          <p className="sb-ticket__ref" style={{ marginTop: "var(--sb-5)" }}>
            error id: {error.digest}
          </p>
        ) : null}
      </section>
    </div>
  );
}
