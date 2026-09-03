"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, Ticket, TrendingDown, TrendingUp, X } from "lucide-react";
import { naira } from "@/lib/money";
import { useBetslip } from "./betslip-store";
import { slipMath, toKobo } from "./slip-math";

/**
 * The betslip.
 *
 * MONEY RULES OBSERVED HERE
 * -------------------------
 * 1. "Potential return" is GROSS and includes the stake. "Profit" is shown as
 *    its own, smaller figure. Labelling the gross number as profit overstates
 *    the win by exactly the stake, and it is the single most common way a
 *    betslip misleads.
 * 2. The figures are a PREVIEW. The server prices the bet from stored odds and
 *    its answer is authoritative; this is here so the customer knows what they
 *    are submitting.
 * 3. Placement goes to the real authenticated route. Nothing here writes a
 *    balance, and a success message is only shown for a response that actually
 *    contains a bet id.
 * 4. The submit button disables while a request is in flight, so a double-tap
 *    cannot become two bets. The route is idempotent as well; this is the
 *    cheaper half of the same guarantee.
 */

const QUICK_STAKES = [100, 500, 1000, 5000];

export function BetslipPanel({
  signedIn,
  balanceMinor,
  compact = false,
}: {
  signedIn: boolean;
  balanceMinor?: string | null;
  compact?: boolean;
}) {
  const slip = useBetslip();
  const [tab, setTab] = useState<"slip" | "mine">("slip");
  const [confirming, setConfirming] = useState(false);

  const stakeMinor = toKobo(slip.stake);
  const { totalOdds, returnMinor, profitMinor } = useMemo(
    () => slipMath(slip.picks, stakeMinor ?? 0n),
    [slip.picks, stakeMinor],
  );

  const balance = balanceMinor ? BigInt(balanceMinor) : null;
  const insufficient = balance !== null && stakeMinor !== null && stakeMinor > balance;

  /* A price that moved after it was added. The customer must see this. */
  const moved = slip.picks
    .map((p) => ({ pick: p, now: slip.drift[p.selectionId] }))
    .filter((x) => typeof x.now === "number" && x.now !== x.pick.odds);

  const stakeInvalid = slip.stake.trim() !== "" && stakeMinor === null;
  const canPlace =
    signedIn &&
    slip.picks.length > 0 &&
    stakeMinor !== null &&
    stakeMinor > 0n &&
    !insufficient &&
    slip.status !== "placing";

  async function place() {
    if (!canPlace || stakeMinor === null) return;
    slip.setStatus("placing");
    try {
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stakeMinor: stakeMinor.toString(),
          idempotencyKey: crypto.randomUUID(),
          legs: slip.picks.map((p) => ({
            selectionId: p.selectionId,
            odds: p.odds.toFixed(3),
          })),
        }),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          body && typeof body === "object" && "message" in body
            ? String((body as { message: unknown }).message)
            : "That bet could not be placed. Nothing has been charged.";
        slip.setStatus("error", message);
        return;
      }

      const betId =
        body && typeof body === "object" && "betId" in body
          ? String((body as { betId: unknown }).betId)
          : null;

      // Only a response carrying a real bet id counts as placed.
      if (!betId) {
        slip.setStatus("error", "The bet may not have been placed. Check My Bets before retrying.");
        return;
      }
      slip.setStatus("placed", null, betId);
    } catch {
      slip.setStatus(
        "error",
        "We could not reach the server. Check My Bets before trying again — nothing is charged twice.",
      );
    } finally {
      setConfirming(false);
    }
  }

  return (
    <section className="sb-panel sb-slip" aria-label="Betslip">
      <div className="sb-slip__tabs" role="tablist" aria-label="Betslip sections">
        <button
          type="button" role="tab" className="sb-slip__tab"
          aria-selected={tab === "slip"} onClick={() => setTab("slip")}
        >
          Betslip{slip.picks.length > 0 ? ` (${slip.picks.length})` : ""}
        </button>
        <button
          type="button" role="tab" className="sb-slip__tab"
          aria-selected={tab === "mine"} onClick={() => setTab("mine")}
        >
          My Bets
        </button>
      </div>

      {tab === "mine" ? (
        <div className="sb-pad sb-stack">
          <p className="sb-small sb-muted">
            Your open and settled bets, with real settlement status.
          </p>
          <Link href="/bets" className="sb-btn sb-btn--ghost" style={{ width: "100%" }}>
            Open My Bets
          </Link>
        </div>
      ) : (
        <>
          {/* ------------------------------------------------ placed */}
          {slip.status === "placed" && slip.placedBetId ? (
            <div className="sb-pad sb-stack">
              <div className="sb-note sb-note--ok" role="status">
                <CheckCircle2 size={15} aria-hidden="true" />
                <span>Bet placed. Reference <strong>{slip.placedBetId.slice(0, 8)}</strong>.</span>
              </div>
              <Link href="/bets" className="sb-btn sb-btn--ghost" style={{ width: "100%" }}>
                View in My Bets
              </Link>
              <button type="button" className="sb-btn sb-btn--primary" style={{ width: "100%" }} onClick={slip.clear}>
                New betslip
              </button>
            </div>
          ) : slip.picks.length === 0 ? (
            /* ------------------------------------------------- empty */
            <div className="sb-empty">
              <Ticket className="sb-empty__icon" size={26} aria-hidden="true" />
              <p className="sb-empty__title">Your betslip is empty</p>
              <p className="sb-small">Tap any odds to add a selection.</p>
            </div>
          ) : (
            <>
              {/* ---------------------------------------- selections */}
              <div>
                {slip.picks.map((pick) => {
                  const now = slip.drift[pick.selectionId];
                  const changed = typeof now === "number" && now !== pick.odds;
                  return (
                    <div className="sb-pick" key={pick.selectionId}>
                      <div className="sb-pick__top">
                        <div style={{ minWidth: 0 }}>
                          <div className="sb-pick__sel">{pick.selectionLabel}</div>
                          <div className="sb-pick__market">{pick.marketKey.replace(/_/g, " ")}</div>
                          <div className="sb-pick__fixture">{pick.fixture}</div>
                        </div>
                        <span className="sb-pick__odds">{pick.odds.toFixed(2)}</span>
                        <button
                          type="button" className="sb-pick__x"
                          aria-label={`Remove ${pick.selectionLabel} from betslip`}
                          onClick={() => slip.remove(pick.selectionId)}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </div>
                      {changed ? (
                        <div className="sb-note sb-note--warn" style={{ padding: "6px 0 0" }} role="status">
                          {now > pick.odds
                            ? <TrendingUp size={14} aria-hidden="true" />
                            : <TrendingDown size={14} aria-hidden="true" />}
                          <span>
                            Odds moved to <strong>{now.toFixed(2)}</strong>. Your bet will be placed at the
                            current price.
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* --------------------------------------------- stake */}
              <div className="sb-pad sb-stack">
                {slip.picks.length > 1 ? (
                  <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                    Accumulator · {slip.picks.length} selections · all must win
                  </p>
                ) : null}

                <label className="sb-sr" htmlFor="sb-stake">Stake in naira</label>
                <input
                  id="sb-stake"
                  className="sb-stake"
                  inputMode="decimal"
                  placeholder="Stake (₦)"
                  value={slip.stake}
                  aria-invalid={stakeInvalid || insufficient}
                  aria-describedby={stakeInvalid || insufficient ? "sb-stake-err" : undefined}
                  onChange={(e) => slip.setStake(e.target.value)}
                />

                <div className="sb-quick">
                  {QUICK_STAKES.map((amount) => (
                    <button key={amount} type="button" onClick={() => slip.setStake(String(amount))}>
                      ₦{amount.toLocaleString("en-NG")}
                    </button>
                  ))}
                </div>

                {stakeInvalid ? (
                  <p id="sb-stake-err" className="sb-note sb-note--error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" />
                    Enter an amount in naira, up to two decimal places.
                  </p>
                ) : null}
                {insufficient ? (
                  <p id="sb-stake-err" className="sb-note sb-note--error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" />
                    That is more than your balance. <Link href="/deposit">Add funds</Link> or lower the stake.
                  </p>
                ) : null}
                {moved.length > 0 ? (
                  <p className="sb-note sb-note--warn" role="status">
                    <AlertTriangle size={14} aria-hidden="true" />
                    {moved.length === 1 ? "One price has" : `${moved.length} prices have`} moved since you
                    added {moved.length === 1 ? "it" : "them"}.
                  </p>
                ) : null}

                <dl style={{ margin: 0 }}>
                  <div className="sb-total">
                    <dt>Total odds</dt>
                    <dd>{totalOdds.toFixed(2)}</dd>
                  </div>
                  <div className="sb-total">
                    <dt>Possible profit</dt>
                    <dd>{naira(profitMinor)}</dd>
                  </div>
                  <div className="sb-total sb-total--major">
                    <dt>Potential return</dt>
                    <dd>{naira(returnMinor)}</dd>
                  </div>
                </dl>
                <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                  Potential return includes your stake. Final prices are confirmed by the server.
                </p>

                {slip.status === "error" && slip.message ? (
                  <p className="sb-note sb-note--error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" />
                    {slip.message}
                  </p>
                ) : null}

                {!signedIn ? (
                  <Link href="/signin" className="sb-btn sb-btn--primary sb-btn--lg">
                    Sign in to place bet
                  </Link>
                ) : confirming ? (
                  <div className="sb-stack">
                    <p className="sb-small sb-bold" style={{ margin: 0 }}>
                      Place {slip.picks.length === 1 ? "this bet" : `this ${slip.picks.length}-fold`} for{" "}
                      {stakeMinor !== null ? naira(stakeMinor) : "—"}?
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="sb-btn sb-btn--ghost" style={{ flex: 1 }} onClick={() => setConfirming(false)}>
                        Cancel
                      </button>
                      <button type="button" className="sb-btn sb-btn--primary" style={{ flex: 1 }} onClick={place} disabled={slip.status === "placing"}>
                        {slip.status === "placing" ? <><Loader2 size={15} className="sb-spin" aria-hidden="true" /> Placing</> : "Confirm"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="sb-btn sb-btn--primary sb-btn--lg"
                    disabled={!canPlace}
                    onClick={() => setConfirming(true)}
                  >
                    Place bet
                  </button>
                )}

                <div className="sb-row-between">
                  <button type="button" className="sb-btn sb-btn--danger" onClick={slip.clear}>
                    Clear all
                  </button>
                  {balance !== null ? (
                    <span className="sb-xs sb-muted">Balance {naira(balance)}</span>
                  ) : null}
                </div>

                <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                  18+. Bet responsibly. <Link href="/responsible">Set a limit</Link>.
                </p>
              </div>
            </>
          )}
        </>
      )}

      {compact ? null : null}
    </section>
  );
}
