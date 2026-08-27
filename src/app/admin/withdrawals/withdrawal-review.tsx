"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface WithdrawalRow {
  id: string;
  email: string;
  amount: string;
  status: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  kycLevel: number;
  provider: string | null;
  providerRef: string | null;
  failureReason: string | null;
  createdAt: string;
}

const TERMINAL = new Set(["PAID", "REJECTED", "FAILED"]);

function pillFor(status: string): string {
  if (status === "PAID") return "pill ok";
  if (status === "REJECTED" || status === "FAILED") return "pill critical";
  if (status === "PROCESSING") return "pill warning";
  return "pill";
}

/**
 * The payout queue.
 *
 * Approving does not send money — it queues the transfer for the payout
 * worker. That is stated on the page, because an operator who believes the
 * money has already gone will answer a customer's "where is it" wrongly.
 */
export function WithdrawalReview({
  withdrawals,
  canReview,
  liveRail,
}: {
  withdrawals: WithdrawalRow[];
  canReview: boolean;
  liveRail: boolean;
}) {
  const router = useRouter();

  const [target, setTarget] = useState<WithdrawalRow | null>(null);
  const [decision, setDecision] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function open(row: WithdrawalRow, mode: "APPROVE" | "REJECT") {
    setTarget(row);
    setDecision(mode);
    setReason("");
    setPassword("");
    setError(null);
    setDone(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!target) return;

    setBusy(true);
    setError(null);
    try {
      // Step one: prove it is still you. Writes a short-lived server-side
      // record; nothing about it travels with the decision itself.
      const reauth = await fetch("/api/admin/reauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!reauth.ok) {
        const body = await reauth.json();
        setError(body.message ?? "That password is not correct.");
        return;
      }

      const response = await fetch("/api/admin/withdrawals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withdrawalId: target.id, decision, reason }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "That decision could not be recorded.");
        return;
      }

      setDone(
        decision === "APPROVE"
          ? `Approved ${target.amount} for ${target.email}. Queued for transfer.`
          : `Rejected ${target.amount} for ${target.email}. Funds returned to their balance.`,
      );
      setTarget(null);
      setPassword("");
      setReason("");
      router.refresh();
    } catch {
      setError("Network problem — nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!liveRail ? (
        <p className="notice warn">
          <strong>Sandbox rail.</strong> No <code>PAYSTACK_SECRET_KEY</code> is configured, so
          approving a withdrawal queues a transfer that moves no real money and stays in
          PROCESSING. Do not use this to settle a genuine customer request.
        </p>
      ) : null}

      {done ? <p className="notice ok">{done}</p> : null}

      <section className="card">
        <h2>Payout queue</h2>
        <p className="muted small">
          Approving does not send the money. It queues the transfer for the payout worker, which
          submits it to the provider and settles the row when the provider reports back.
        </p>

        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">Requested</th>
                <th scope="col">Account</th>
                <th scope="col">Destination</th>
                <th scope="col" className="right">Amount</th>
                <th scope="col">Status</th>
                {canReview ? <th scope="col" className="right">Decision</th> : null}
              </tr>
            </thead>
            <tbody>
              {withdrawals.length === 0 ? (
                <tr>
                  <td colSpan={canReview ? 6 : 5} className="muted">
                    Nothing awaiting a decision.
                  </td>
                </tr>
              ) : (
                withdrawals.map((row) => (
                  <tr key={row.id}>
                    <td className="muted small">
                      {new Date(row.createdAt).toLocaleString("en-NG")}
                    </td>
                    <td>
                      {row.email}
                      <br />
                      <span className={row.kycLevel >= 1 ? "pill" : "pill critical"}>
                        KYC {row.kycLevel}
                      </span>
                    </td>
                    <td className="muted small">
                      {row.accountName}
                      <br />
                      {row.accountNumber} · {row.bankCode}
                    </td>
                    <td className="right">{row.amount}</td>
                    <td>
                      <span className={pillFor(row.status)}>{row.status}</span>
                      {row.failureReason ? (
                        <>
                          <br />
                          <span className="muted small">{row.failureReason}</span>
                        </>
                      ) : null}
                      {row.provider ? (
                        <>
                          <br />
                          <span className="muted small">
                            {row.provider}
                            {row.providerRef ? ` · ${row.providerRef.slice(0, 18)}` : ""}
                          </span>
                        </>
                      ) : null}
                    </td>
                    {canReview ? (
                      <td className="right">
                        {TERMINAL.has(row.status) || row.status === "PROCESSING" ? (
                          <span className="muted small">—</span>
                        ) : (
                          <span style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => open(row, "APPROVE")}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="btn sm danger"
                              onClick={() => open(row, "REJECT")}
                            >
                              Reject
                            </button>
                          </span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!canReview ? (
          <p className="muted small legal">
            You can see this queue but not act on it. Approving a payout needs the
            <code> withdrawals.review</code> permission, which belongs to finance.
          </p>
        ) : null}
      </section>

      {target ? (
        <section className="card form-card">
          <h2>
            {decision === "APPROVE" ? "Approve" : "Reject"} {target.amount}
          </h2>
          <p className="muted small">
            {target.email} → {target.accountName}, {target.accountNumber}
          </p>

          {decision === "APPROVE" ? (
            <p className="notice warn">
              Check the destination account against the account holder&rsquo;s verified name. A
              payout to a third party is how a laundered deposit leaves the platform.
            </p>
          ) : (
            <p className="notice info">
              Rejecting returns {target.amount} to the customer&rsquo;s cash balance immediately.
            </p>
          )}

          <form onSubmit={submit}>
            <label className="field">
              Reason
              <input
                required
                minLength={3}
                maxLength={500}
                placeholder="Why is this being approved or rejected?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <span className="hint">Recorded in the audit log. Required.</span>
            </label>

            <label className="field">
              Confirm your password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="hint">Moving money needs more than an open session.</span>
            </label>

            {error ? (
              <p className="notice error" role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              className="place"
              disabled={busy || reason.trim().length < 3 || !password}
            >
              {busy ? "Working…" : decision === "APPROVE" ? "Approve payout" : "Reject request"}
            </button>
            <button type="button" className="link-button" onClick={() => setTarget(null)}>
              Cancel
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
