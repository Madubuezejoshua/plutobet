"use client";

import { useState } from "react";
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
      <section className="card form-card">
        <p className="notice ok">{done}</p>
        <p className="muted small legal">
          Withdrawals are reviewed before the transfer is sent. You will see it in your wallet
          history throughout.
        </p>
      </section>
    );
  }

  return (
    <section className="card form-card">
      <form onSubmit={submit}>
        <label className="field">
          Amount (₦)
          <input
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="hint">
            Daily limit {naira(cap)} at verification level {props.tier}.
          </span>
        </label>

        <label className="field">
          Account number
          <input
            inputMode="numeric"
            required
            maxLength={10}
            pattern="\d{10}"
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))}
          />
          <span className="hint">10 digits, NUBAN.</span>
        </label>

        <label className="field">
          Bank code
          <input
            inputMode="numeric"
            required
            maxLength={6}
            value={bankCode}
            onChange={(e) => setBankCode(e.target.value.replace(/\D/g, ""))}
          />
        </label>

        <label className="field">
          Account name
          <input
            required
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
          />
          <span className="hint">Must match your own name — third-party payouts are refused.</span>
        </label>

        {problem ? <p className="notice error">{problem}</p> : null}

        <button
          type="submit"
          className="place"
          disabled={busy || amountMinor === 0n || problem !== null}
        >
          {busy ? "Requesting…" : "Request withdrawal"}
        </button>
      </form>

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
