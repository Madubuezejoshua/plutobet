"use client";

/**
 * Last-resort error boundary.
 *
 * Next.js's default is "A server error occurred. Reload to try again." — which
 * is true, unactionable, and identical whether the cause is a missing
 * environment variable, an unreachable database, or a genuine bug. The first
 * Railway deployment showed exactly that on every page, and the only way to
 * learn why was to read the source.
 *
 * This replaces it with the same honesty plus a next step: point the operator
 * at /api/health, which names the failing configuration.
 *
 * The digest is Next's own error id and is safe to show — it carries no stack
 * and no message, and it is what correlates this page with the server log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#080b12",
          color: "#e6ebf5",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          padding: "1.5rem",
        }}
      >
        <main style={{ maxWidth: "34rem", width: "100%" }}>
          <p
            style={{
              margin: 0,
              fontSize: "0.75rem",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#7d8aa3",
            }}
          >
            PlutoBet
          </p>

          <h1 style={{ margin: "0.5rem 0 0", fontSize: "1.5rem", lineHeight: 1.25 }}>
            Something went wrong on our side
          </h1>

          <p style={{ margin: "0.75rem 0 0", color: "#a7b2c7", lineHeight: 1.6 }}>
            No money moves on a failed page load. Nothing has been placed, paid or
            changed by this error.
          </p>

          <div
            style={{
              margin: "1.5rem 0 0",
              padding: "1rem",
              borderRadius: "0.6rem",
              background: "#0e131d",
              border: "1px solid #1d2637",
            }}
          >
            <p style={{ margin: 0, fontSize: "0.8rem", color: "#7d8aa3" }}>
              If you are deploying this site, open{" "}
              <a href="/api/health" style={{ color: "#7fd1ff" }}>
                /api/health
              </a>{" "}
              — it names any missing configuration.
            </p>
            {error.digest ? (
              <p
                style={{
                  margin: "0.6rem 0 0",
                  fontSize: "0.75rem",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: "#5f6b80",
                }}
              >
                error id: {error.digest}
              </p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              padding: "0.7rem 1.4rem",
              borderRadius: "0.5rem",
              border: "none",
              background: "#2f6df6",
              color: "white",
              fontSize: "0.95rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
