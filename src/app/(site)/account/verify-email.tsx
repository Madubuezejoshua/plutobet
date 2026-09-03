"use client";

import { useState } from "react";

/**
 * Email verification, from the account page.
 *
 * The OTP service and the `EMAIL_VERIFY` purpose already existed — what was
 * missing was any way for a customer to reach them, so the "Unverified" pill
 * beside their address was a dead end and `email_verified_at` stayed null on
 * every account ever created.
 *
 * Renders nothing once verified. A control whose only outcome is "you already
 * did this" is clutter on the page a customer visits to check their details.
 */

type Stage = "idle" | "sending" | "sent" | "confirming" | "done";

export function VerifyEmail({ verified }: { verified: boolean }) {
  const [stage, setStage] = useState<Stage>(verified ? "done" : "idle");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  /* Only ever set when no email provider is configured. Without it the flow
   * cannot be completed locally, because the code goes to a server log. */
  const [devCode, setDevCode] = useState<string | null>(null);

  if (stage === "done") return null;

  async function send() {
    setError(null);
    setStage("sending");
    try {
      const res = await fetch("/api/account/email-verify", { method: "POST" });
      const body = await res.json();

      if (body.alreadyVerified) {
        setStage("done");
        return;
      }
      if (!res.ok) {
        setError(body.message ?? "Could not send a code. Try again shortly.");
        setStage("idle");
        return;
      }
      setDevCode(body.devCode ?? null);
      setStage("sent");
    } catch {
      setError("Could not reach the server. Check your connection.");
      setStage("idle");
    }
  }

  async function confirm() {
    setError(null);
    setStage("confirming");
    try {
      const res = await fetch("/api/account/email-verify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const body = await res.json();

      if (!res.ok) {
        // The service distinguishes wrong, expired and exhausted; its message
        // is more useful than anything this component could invent.
        setError(body.message ?? "That code did not work.");
        setStage("sent");
        return;
      }
      setStage("done");
    } catch {
      setError("Could not reach the server. Check your connection.");
      setStage("sent");
    }
  }

  return (
    <div style={{ marginTop: "0.75rem" }}>
      {stage === "sent" || stage === "confirming" ? (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <input className="sb-input"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            placeholder="6-digit code"
            aria-label="Verification code"
            style={{ maxWidth: "9rem" }}
          />
          <button
            type="button"
            className="sb-btn sb-btn--primary"
            onClick={confirm}
            disabled={stage === "confirming" || code.trim().length < 4}
          >
            {stage === "confirming" ? "Checking…" : "Confirm"}
          </button>
          <button type="button" className="sb-btn sb-btn--ghost" onClick={send}>
            Resend
          </button>
        </div>
      ) : (
        <button type="button" className="sb-btn sb-btn--ghost" onClick={send} disabled={stage === "sending"}>
          {stage === "sending" ? "Sending…" : "Verify email"}
        </button>
      )}

      {devCode ? (
        <p className="sb-muted" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
          No email provider is configured, so the code is shown here for testing:{" "}
          <strong>{devCode}</strong>
        </p>
      ) : null}

      {error ? (
        <p role="alert" style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--danger, #ff6b6b)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
