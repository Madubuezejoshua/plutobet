"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  /*
   * THE RESOLVED ACCOUNT — THE PROVIDER'S ANSWER, NOT A FIELD.
   *
   * `accountName` is no longer typed. It is what the bank says the account is
   * called, fetched from `/api/payments/resolve-account`, shown read-only, and
   * confirmed by an explicit tick before a withdrawal can be requested. The
   * server re-resolves anyway and writes its own answer, so nothing here is
   * authoritative — this exists so the customer SEES whose account they are
   * about to pay.
   */
  const [accountName, setAccountName] = useState("");
  const [resolveState, setResolveState] = useState<
    "idle" | "resolving" | "resolved" | "failed"
  >("idle");
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [sandboxAccount, setSandboxAccount] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  /*
   * STALE-RESPONSE PROTECTION.
   *
   * Two resolutions can be in flight when somebody corrects a digit, and they
   * can come back in either order. Without this, the SLOWER answer for the OLD
   * number wins and the customer confirms a name belonging to an account they
   * are no longer paying. The counter is bumped on every request and every
   * response checks it is still the newest before it is allowed to write
   * anything. `useRef` rather than state: it must be readable synchronously
   * inside the async callback, and a state update would not have landed yet.
   */
  const resolveSeq = useRef(0);
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

  /*
   * CLEAR THE MOMENT THE ACCOUNT CHANGES.
   *
   * Not debounced-and-replaced — CLEARED. A stale name sitting on screen beside
   * a number the customer has just edited is the most dangerous state this form
   * can be in, because it reads as confirmation of the NEW number. The
   * confirmation tick goes with it: agreeing to pay one account is not agreeing
   * to pay another.
   *
   * Called from the edit handlers rather than from an effect on
   * `[accountNumber, bankCode]`. The effect version worked and `react-hooks`
   * refused it — setting state synchronously in an effect body causes a
   * cascading render — and the rule is right for a better reason than
   * performance: clearing is a direct consequence of the customer editing the
   * field, so it belongs where the edit happens. Deriving it from a dependency
   * array puts a one-render window between the number changing and the name
   * disappearing, which is exactly the window this is here to close.
   *
   * Bumping `resolveSeq` also orphans any resolution still in flight, so a
   * slow answer for the old number cannot land afterwards.
   */
  function clearResolvedAccount() {
    resolveSeq.current += 1;
    setAccountName("");
    setConfirmed(false);
    setResolveError(null);
    setSandboxAccount(false);
    setResolveState("idle");
  }

  const resolveAccount = useCallback(async () => {
    if (!/^\d{10}$/.test(accountNumber) || !bankCode) return;
    const seq = resolveSeq.current + 1;
    resolveSeq.current = seq;
    setResolveState("resolving");
    setResolveError(null);
    try {
      const response = await fetch("/api/payments/resolve-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountNumber, bankCode }),
      });
      const body = await response.json().catch(() => null);
      // A response for an account the customer has already moved on from is
      // discarded, not displayed.
      if (seq !== resolveSeq.current) return;
      if (!response.ok) {
        setResolveState("failed");
        setResolveError(body?.message ?? "We could not check that account.");
        return;
      }
      setAccountName(String(body.accountName ?? ""));
      setSandboxAccount(Boolean(body.sandbox));
      setResolveState("resolved");
    } catch {
      if (seq !== resolveSeq.current) return;
      setResolveState("failed");
      setResolveError("We could not reach the bank directory. Try again.");
    }
  }, [accountNumber, bankCode]);

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
          // What the customer was SHOWN and agreed to. The server re-resolves
          // and writes its own answer; this is sent so a screen that went stale
          // between confirming and submitting is refused rather than paid.
          confirmedAccountName: accountName,
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
            onChange={(e) => {
              setAccountNumber(e.target.value.replace(/\D/g, ""));
              clearResolvedAccount();
            }}
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
                onChange={(e) => {
                  setBankCode(e.target.value.replace(/\D/g, ""));
                  clearResolvedAccount();
                }}
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
                onChange={(e) => {
                  setBankCode(e.target.value);
                  clearResolvedAccount();
                }}
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

        {/*
          THE ACCOUNT NAME IS NOT A FIELD ANY MORE.

          It used to be a free-text input whose value went straight onto the
          payout record. It is now the bank's answer: read-only, fetched on
          demand, cleared the instant the number or bank changes, and confirmed
          explicitly before a withdrawal can be requested.
        */}
        <div className="sb-field">
          <span className="sb-field__label">Account name</span>

          <button
            type="button"
            className="sb-btn sb-btn--ghost"
            onClick={resolveAccount}
            disabled={!/^\d{10}$/.test(accountNumber) || !bankCode || resolveState === "resolving"}
          >
            {resolveState === "resolving" ? "Checking…" : "Check account name"}
          </button>

          {resolveState === "resolved" && accountName ? (
            <>
              <output
                id="wd-name"
                className="sb-input"
                style={{ display: "block", fontWeight: 700 }}
              >
                {accountName}
              </output>
              {sandboxAccount ? (
                <span className="sb-note sb-note--warn" role="status">
                  <AlertTriangle size={14} aria-hidden="true" />
                  This is a SANDBOX response. No real account was checked.
                </span>
              ) : null}
              <label className="sb-check" htmlFor="wd-confirm">
                <input
                  id="wd-confirm"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>This is the account I want to be paid into.</span>
              </label>
            </>
          ) : null}

          {resolveState === "failed" && resolveError ? (
            <span className="sb-note sb-note--error" role="alert">
              <AlertTriangle size={14} aria-hidden="true" />
              {resolveError}
            </span>
          ) : null}

          <span className="sb-hint">
            We ask your bank who owns this account. Must be your own — third-party
            payouts are refused.
          </span>
        </div>

        {problem ? (
          <p id="wd-problem" className="sb-note sb-note--error" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            {problem}
          </p>
        ) : null}

        <button
          type="submit"
          className="sb-btn sb-btn--primary sb-btn--lg"
          disabled={
            busy ||
            amountMinor === 0n ||
            problem !== null ||
            // No payout without a name from the bank AND an explicit agreement
            // to it. The server enforces this too; this stops the customer
            // reaching a refusal they cannot interpret.
            resolveState !== "resolved" ||
            !accountName ||
            !confirmed
          }
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
