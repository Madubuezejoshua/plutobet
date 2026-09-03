"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Banknote, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { naira } from "@/lib/money";

/**
 * Cash-out on a pending ticket.
 *
 * WHAT THIS COMPONENT IS NOT ALLOWED TO DO. It does not price anything. The
 * offer shown always comes from the server, and the amount paid is decided
 * again on the server under the bet's row lock at the moment the customer
 * accepts. Nothing here can be edited into a better price.
 *
 * THE OFFER IS NOT FETCHED UNTIL ASKED FOR. A bets page with ten open tickets
 * would otherwise fire ten pricing requests on every load, most of them for
 * offers nobody looks at. The customer presses "Cash out" and then sees a
 * price, which is also the honest order: an offer that appears without being
 * requested invites a decision that was not being made.
 *
 * THE PRICE THE CUSTOMER SAW IS SENT BACK as `expectedOfferMinor`. The server
 * refuses to pay less than that, so a drift between seeing and accepting cannot
 * quietly shortchange them. A HIGHER offer is paid in full — they are not
 * penalised for the seconds in between.
 */

interface Quote {
  available: boolean;
  offerMinor?: string;
  reason?: string;
  message?: string;
}

type Stage = "idle" | "quoting" | "offered" | "taking" | "done" | "error";

/** Reasons the customer can act on, in their own words. */
const REASON_TEXT: Record<string, string> = {
  BET_NOT_PENDING: "This bet has already been settled.",
  LEG_ALREADY_LOST: "One of your selections has lost, so there is nothing to buy back.",
  LEG_NOT_PRICEABLE: "One of these markets is suspended, so we cannot price it right now.",
  VALUE_TOO_SMALL: "This is worth less than the minimum we can pay out.",
  ACCOUNT_NOT_ELIGIBLE: "Cash-out is not available on this account.",
};

export function CashOut({ betId, stakeMinor }: { betId: string; stakeMinor: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [paidMinor, setPaidMinor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);

  const explain = useCallback((reason: string | undefined, fallback: string) => {
    return (reason && REASON_TEXT[reason]) || fallback;
  }, []);

  async function getQuote() {
    setStage("quoting");
    setMessage(null);
    try {
      const response = await fetch(`/api/bets/${betId}/cashout`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as
        | (Quote & { error?: string; message?: string })
        | null;

      if (!response.ok || !body) {
        setStage("error");
        setMessage(explain(body?.error, "We could not price this bet. Try again shortly."));
        return;
      }
      if (!body.available) {
        setStage("error");
        setMessage(explain(body.reason, "Cash-out is not available on this bet right now."));
        return;
      }
      setQuote(body);
      setStage("offered");
    } catch {
      setStage("error");
      setMessage("We could not reach the server. Check your connection and try again.");
    }
  }

  async function take() {
    if (!quote?.offerMinor) return;
    setStage("taking");
    setMessage(null);
    try {
      const response = await fetch(`/api/bets/${betId}/cashout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // The figure on screen, as a guard. The server pays this or more,
          // never less.
          expectedOfferMinor: quote.offerMinor,
          // Half the ORIGINAL stake, and only when the customer chose it.
          ...(partial ? { stakePortionMinor: (BigInt(stakeMinor) / 2n).toString() } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { offerMinor?: string; error?: string; message?: string }
        | null;

      if (!response.ok || !body?.offerMinor) {
        setStage("error");
        setMessage(
          explain(
            body?.error,
            "That cash-out could not be completed. Nothing has been paid — check My Bets before retrying.",
          ),
        );
        return;
      }

      setPaidMinor(body.offerMinor);
      setStage("done");
      // The ticket, the balance in the header and the wallet all change. Let
      // the server re-render rather than patching a figure in the browser.
      router.refresh();
    } catch {
      setStage("error");
      setMessage(
        "We could not reach the server. Nothing is paid twice — check My Bets before trying again.",
      );
    }
  }

  if (stage === "done" && paidMinor) {
    return (
      <p className="sb-note sb-note--ok" role="status">
        <CheckCircle2 size={15} aria-hidden="true" />
        Cashed out for <strong>{naira(paidMinor)}</strong>.
      </p>
    );
  }

  return (
    <div className="sb-cashout">
      {stage === "offered" && quote?.offerMinor ? (
        <>
          <div className="sb-cashout__offer">
            <span className="sb-xs sb-muted">Cash out now for</span>
            <strong className="sb-cashout__value">{naira(quote.offerMinor)}</strong>
          </div>

          <label className="sb-cashout__half">
            <input
              type="checkbox"
              checked={partial}
              onChange={(event) => setPartial(event.target.checked)}
            />
            <span>
              Take half and leave the rest running
              <span className="sb-xs sb-muted" style={{ display: "block" }}>
                You keep {naira(BigInt(stakeMinor) / 2n)} of the stake on this bet.
              </span>
            </span>
          </label>

          <div className="sb-cashout__actions">
            <button type="button" className="sb-btn sb-btn--ghost" onClick={() => setStage("idle")}>
              Not now
            </button>
            <button type="button" className="sb-btn sb-btn--primary" onClick={take}>
              Accept {naira(quote.offerMinor)}
            </button>
          </div>

          <p className="sb-xs sb-muted" style={{ margin: 0 }}>
            Prices move. If this offer changes before you accept, we pay the higher of the two —
            never less than the figure shown here.
          </p>
        </>
      ) : stage === "taking" ? (
        <button type="button" className="sb-btn sb-btn--primary" disabled>
          <Loader2 size={15} className="sb-spin" aria-hidden="true" /> Cashing out
        </button>
      ) : stage === "quoting" ? (
        <button type="button" className="sb-btn sb-btn--ghost" disabled>
          <Loader2 size={15} className="sb-spin" aria-hidden="true" /> Getting a price
        </button>
      ) : (
        <button type="button" className="sb-btn sb-btn--ghost" onClick={getQuote}>
          {stage === "error" ? (
            <>
              <RefreshCw size={15} aria-hidden="true" /> Try again
            </>
          ) : (
            <>
              <Banknote size={15} aria-hidden="true" /> Cash out
            </>
          )}
        </button>
      )}

      {message ? (
        <p className="sb-note sb-note--warn" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          {message}
        </p>
      ) : null}
    </div>
  );
}
