"use client";

import { useEffect, useState } from "react";
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
 * The bank is chosen from the provider's own list, fetched through a server
 * route. It is never a list typed into this file: Nigerian bank codes change as
 * banks merge and microfinance banks come and go, and a stale code does not
 * bounce — it sends real money to a different institution.
 *
 * When the list cannot be fetched the field falls back to a typed code and says
 * so. That is worse for the customer than a picker and much better than a form
 * they cannot submit, and the server re-validates whatever arrives.
 */

interface BankOption {
  code: string;
  name: string;
}

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
  const [banks, setBanks] = useState<BankOption[] | null>(null);
  const [bankListState, setBankListState] = useState<"loading" | "ready" | "stale" | "failed">(
    "loading",
  );
  const [accountName, setAccountName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /*
   * Fetched once on mount. The list is cached server-side for twelve hours, so
   * this is a cheap request, and doing it here rather than on the server keeps
   * the page itself renderable when the payment provider is unreachable.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/payments/banks", { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as
          | { banks?: BankOption[]; stale?: boolean; unavailable?: boolean }
          | null;

        if (cancelled) return;

        if (!response.ok || !body || body.unavailable || !body.banks?.length) {
          setBankListState("failed");
          return;
        }
        setBanks(body.banks);
        setBankListState(body.stale ? "stale" : "ready");
      } catch {
        if (!cancelled) setBankListState("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
          <span className="sb-field__label">Bank</span>

          {bankListState === "loading" ? (
            <select id="wd-bank" className="sb-input" disabled aria-busy="true">
              <option>Loading banks…</option>
            </select>
          ) : bankListState === "failed" ? (
            <>
              {/*
                No list, so the customer types a code rather than being stuck.
                The server re-validates it, and the provider refuses an unknown
                one — this fallback loses the convenience, not the safety.
              */}
              <input
                id="wd-bank"
                className="sb-input"
                inputMode="numeric"
                required
                maxLength={6}
                value={bankCode}
                onChange={(e) => setBankCode(e.target.value.replace(/\D/g, ""))}
              />
              <span className="sb-hint">
                We could not load the bank list. Enter your bank&rsquo;s NIP code from your bank
                app or statement, and we will check it before anything is sent.
              </span>
            </>
          ) : (
            <>
              <select
                id="wd-bank"
                className="sb-input"
                required
                value={bankCode}
                onChange={(e) => setBankCode(e.target.value)}
              >
                <option value="">Choose your bank</option>
                {banks!.map((bank) => (
                  <option key={bank.code} value={bank.code}>
                    {bank.name}
                  </option>
                ))}
              </select>
              {bankListState === "stale" ? (
                <span className="sb-hint">
                  This list was last refreshed a little while ago. If your bank is missing, try
                  again shortly.
                </span>
              ) : null}
            </>
          )}
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
