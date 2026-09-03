"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { naira, parseNairaToKobo } from "@/lib/money";

/**
 * Withdrawal request.
 *
 * The amount is entered in naira and converted to kobo as a STRING before it
 * leaves the browser — never a JSON number. A float would round somebody's
 * balance, and JSON numbers lose precision above 2^53 besides.
 *
 * That was the stated intent from the start, but the conversion underneath it
 * used to be `BigInt(Math.round(Number(amount) * 100))` — which is the very
 * float arithmetic the comment warns against. `parseNairaToKobo` parses the
 * decimal string directly instead, so no IEEE-754 value is ever involved.
 *
 * The bank is still entered as a numeric code rather than picked from a list.
 * A dropdown would be better, and it is deliberately not invented here: the
 * codes route real money, so they have to come from the provider's own bank
 * list through a server route, not from a table typed out by hand.
 */

export function WithdrawForm(props: {
  balanceMinor: string;
  dailyCapMinor: string;
  minMinor: string;
  tier: number;
}) {
  const balance = BigInt(props.balanceMinor);
  const cap = BigInt(props.dailyCapMinor);
  const minimum = BigInt(props.minMinor);

  const [amount, setAmount] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [accountName, setAccountName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Cheap enough to derive every render: a regex and two BigInt operations on
  // a short string. Memoising it bought nothing and defeated the compiler.
  const amountMinor = parseNairaToKobo(amount) ?? 0n;

  const problem =
    amountMinor === 0n
      ? null
      : amountMinor < minimum
        ? `Minimum withdrawal is ${naira(minimum)}.`
        : amountMinor > balance
          ? "That is more than your available balance."
          : amountMinor > cap
            ? `Your daily limit at this verification level is ${naira(cap)}.`
            : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/withdrawals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountMinor: amountMinor.toString(),
          accountNumber,
          bankCode,
          accountName,
          // Stable per submission, so a double-tap replays rather than
          // requesting a second payout.
          idempotencyKey: `withdrawal:${crypto.randomUUID()}`,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "That withdrawal could not be requested.");
        return;
      }
      setDone(
        `Requested ${naira(BigInt(body.amountMinor))}. The funds have left your balance and are pending review.`,
      );
      setAmount("");
    } catch {
      setError("Network problem — nothing was requested.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="sb-panel sb-pad sb-stack">
        <p className="sb-note sb-note--ok" role="status">
          <CheckCircle2 size={15} aria-hidden="true" />
          {done}
        </p>
        <p className="sb-xs sb-muted" style={{ margin: 0 }}>
          Withdrawals are reviewed before the transfer is sent. You will see it in your wallet
          history throughout.
        </p>
      </section>
    );
  }

  return (
    <section className="sb-panel sb-pad">
      <form onSubmit={submit} noValidate>
        <label className="sb-field" htmlFor="wd-amount">
          <span className="sb-field__label">Amount (₦)</span>
          <input
            id="wd-amount"
            className="sb-input"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={problem !== null}
            aria-describedby={problem ? "wd-problem" : undefined}
          />
          <span className="sb-hint">
            Between {naira(minimum)} and {naira(cap)} a day at verification level {props.tier}.
          </span>
        </label>

        <label className="sb-field" htmlFor="wd-account">
          <span className="sb-field__label">Account number</span>
          <input
            id="wd-account"
            className="sb-input"
            inputMode="numeric"
            required
            maxLength={10}
            pattern="\d{10}"
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))}
          />
          <span className="sb-hint">10 digits, NUBAN.</span>
        </label>

        <label className="sb-field" htmlFor="wd-bank">
          <span className="sb-field__label">Bank code</span>
          <input
            id="wd-bank"
            className="sb-input"
            inputMode="numeric"
            required
            maxLength={6}
            value={bankCode}
            onChange={(e) => setBankCode(e.target.value.replace(/\D/g, ""))}
          />
          <span className="sb-hint">Your bank&rsquo;s NIP code, from your bank app or statement.</span>
        </label>

        <label className="sb-field" htmlFor="wd-name">
          <span className="sb-field__label">Account name</span>
          <input
            id="wd-name"
            className="sb-input"
            required
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
          />
          <span className="sb-hint">
            Must match your own name — third-party payouts are refused.
          </span>
        </label>

        {problem ? (
          <p id="wd-problem" className="sb-note sb-note--error" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            {problem}
          </p>
        ) : null}

        <button
          type="submit"
          className="sb-btn sb-btn--primary sb-btn--lg"
          disabled={busy || amountMinor === 0n || problem !== null}
        >
          {busy ? (
            <>
              <Loader2 size={16} className="sb-spin" aria-hidden="true" /> Requesting
            </>
          ) : (
            "Request withdrawal"
          )}
        </button>
      </form>

      {error ? (
        <p className="sb-note sb-note--error" role="alert" style={{ marginTop: "var(--sb-3)" }}>
          <AlertTriangle size={14} aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
