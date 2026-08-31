"use client";

import Link from "next/link";

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
    <section className="card raised" style={{ maxWidth: "34rem", margin: "3rem auto", padding: "1.75rem" }}>
      <h1 style={{ margin: 0, fontSize: "1.35rem" }}>This page didn’t load</h1>

      <p style={{ margin: "0.75rem 0 0", lineHeight: 1.6, opacity: 0.85 }}>
        Something failed on our side. Nothing was placed, paid or changed — your
        balance and any open bets are untouched.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem", flexWrap: "wrap" }}>
        <button type="button" onClick={reset} className="btn primary">
          Try again
        </button>
        <Link href="/" className="btn">
          Go to home
        </Link>
        <Link href="/bets" className="btn">
          My bets
        </Link>
      </div>

      {error.digest ? (
        <p
          style={{
            margin: "1.25rem 0 0",
            fontSize: "0.75rem",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            opacity: 0.5,
          }}
        >
          error id: {error.digest}
        </p>
      ) : null}
    </section>
  );
}
