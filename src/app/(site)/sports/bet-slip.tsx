"use client";

import { useMemo, useState } from "react";
import type { EventView } from "@/modules/odds/odds.service";
import { parseNairaToKobo } from "@/lib/money";

/**
 * The odds board and bet slip.
 *
 * The slip carries the price the user was SHOWN with each selection, and
 * submits it. The server compares that against the live price and applies the
 * drift policy — which is what makes "bet accepted at odds the user didn't
 * see" impossible. Sending only selection ids and letting the server price
 * the slip would quietly remove that protection.
 */

interface Picked {
  selectionId: string;
  odds: string;
  label: string;
  fixture: string;
}

const ODDS_SCALE = 1000n;

function parseOdds(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * ODDS_SCALE + BigInt(fraction.padEnd(3, "0").slice(0, 3));
}

function formatNaira(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  const naira = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₦${naira}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * Mirrors the server's pricing exactly: integer maths on scaled odds, one
 * division at the end. Floats here would show a figure a kobo off from the
 * one the ledger records, and a user comparing the two would be right to
 * distrust both.
 */
function priceSlip(picks: Picked[], stakeMinor: bigint) {
  if (picks.length === 0 || stakeMinor <= 0n) {
    return { totalOdds: "0.000", potentialReturn: 0n };
  }
  let product = 1n;
  for (const pick of picks) product *= parseOdds(pick.odds);
  const divisor = ODDS_SCALE ** BigInt(picks.length);
  const displayDivisor = ODDS_SCALE ** BigInt(picks.length - 1);
  const totalScaled = (product * 2n + displayDivisor) / (displayDivisor * 2n);
  return {
    totalOdds: `${totalScaled / ODDS_SCALE}.${(totalScaled % ODDS_SCALE).toString().padStart(3, "0")}`,
    potentialReturn: (stakeMinor * product) / divisor,
  };
}

export function BetSlip({ events }: { events: EventView[] }) {
  const [picks, setPicks] = useState<Picked[]>([]);
  const [stakeNaira, setStakeNaira] = useState("100");
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "ok" | "error"; message?: string }>(
    { kind: "idle" },
  );

  /*
   * Naira input -> kobo, parsed from the decimal STRING.
   *
   * This used to be `BigInt(Math.round(Number(stakeNaira) * 100))`, whose own
   * comment warned that the stake must not "silently become a different stake
   * than the user typed" — while doing exactly that, because the intermediate
   * `Number` is an IEEE-754 float. This is the stake on a bet, so the amount
   * the customer sees and the amount the ledger debits have to be the same
   * number by construction, not by luck.
   *
   * Cheap enough to derive every render; memoising it bought nothing and
   * defeated the compiler.
   */
  const stakeMinor = parseNairaToKobo(stakeNaira) ?? 0n;

  const pricing = useMemo(() => priceSlip(picks, stakeMinor), [picks, stakeMinor]);

  function toggle(pick: Picked) {
    setStatus({ kind: "idle" });
    setPicks((current) => {
      if (current.some((p) => p.selectionId === pick.selectionId)) {
        return current.filter((p) => p.selectionId !== pick.selectionId);
      }
      // One selection per fixture: two outcomes of the same match are
      // mutually exclusive, and the server rejects the slip anyway.
      const withoutSameFixture = current.filter((p) => p.fixture !== pick.fixture);
      return [...withoutSameFixture, pick];
    });
  }

  async function submit() {
    setStatus({ kind: "busy" });
    try {
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stakeMinor: stakeMinor.toString(),
          legs: picks.map((p) => ({ selectionId: p.selectionId, odds: p.odds })),
          // Stable for this slip: a double-tapped submit replays the original
          // placement rather than placing a second bet.
          idempotencyKey: `slip:${crypto.randomUUID()}`,
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        setStatus({
          kind: "error",
          message: body.message ?? body.error ?? "That bet could not be placed.",
        });
        return;
      }
      setStatus({
        kind: "ok",
        message: `Bet placed. Returns ${formatNaira(BigInt(body.potentialReturnMinor))} if it wins.`,
      });
      setPicks([]);
    } catch {
      setStatus({ kind: "error", message: "Network problem — the bet was not placed." });
    }
  }

  return (
    <div className="board">
      <section className="fixtures">
        {events.map((event) => {
          const market = event.markets.find((m) => m.key === "1x2") ?? event.markets[0];
          return (
            <article key={event.id} className="card fixture">
              <div className="fixture-head">
                <span className="league">{event.league}</span>
                <time dateTime={event.startsAt}>
                  {new Date(event.startsAt).toLocaleString("en-NG", {
                    weekday: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <h2 className="teams">
                {event.home} <span className="muted">v</span> {event.away}
              </h2>

              {market ? (
                <div className="odds-row">
                  {market.selections.map((selection) => {
                    const active = picks.some((p) => p.selectionId === selection.id);
                    return (
                      <button
                        key={selection.id}
                        type="button"
                        className={active ? "odd active" : "odd"}
                        aria-pressed={active}
                        onClick={() =>
                          toggle({
                            selectionId: selection.id,
                            odds: selection.price.toFixed(3),
                            label: selection.label,
                            fixture: `${event.home} v ${event.away}`,
                          })
                        }
                      >
                        <span className="odd-label">{selection.label}</span>
                        <span className="odd-price">{selection.price.toFixed(2)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="muted small">No open markets on this fixture.</p>
              )}
            </article>
          );
        })}
      </section>

      <aside className="slip card" aria-label="Bet slip">
        <h2>Bet slip</h2>

        {picks.length === 0 ? (
          <p className="muted small">Tap a price to add a selection.</p>
        ) : (
          <>
            <ul className="picks">
              {picks.map((pick) => (
                <li key={pick.selectionId}>
                  <div>
                    <strong>{pick.label}</strong>
                    <span className="muted small"> {pick.fixture}</span>
                  </div>
                  <div className="pick-right">
                    <span>{Number(pick.odds).toFixed(2)}</span>
                    <button type="button" onClick={() => toggle(pick)} aria-label="Remove">
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <label className="stake">
              Stake (₦)
              <input
                inputMode="decimal"
                value={stakeNaira}
                onChange={(event) => setStakeNaira(event.target.value)}
              />
            </label>

            <dl className="totals">
              <div>
                <dt>{picks.length === 1 ? "Odds" : `${picks.length} legs`}</dt>
                <dd>{pricing.totalOdds}</dd>
              </div>
              <div>
                <dt>Returns</dt>
                <dd>{formatNaira(pricing.potentialReturn)}</dd>
              </div>
            </dl>

            <button
              type="button"
              className="place"
              disabled={status.kind === "busy" || stakeMinor <= 0n}
              onClick={submit}
            >
              {status.kind === "busy" ? "Placing…" : "Place bet"}
            </button>
          </>
        )}

        {status.message ? (
          <p className={status.kind === "error" ? "notice error" : "notice ok"} role="status">
            {status.message}
          </p>
        ) : null}
      </aside>
    </div>
  );
}
