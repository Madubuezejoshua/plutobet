"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Search, Ticket, X } from "lucide-react";
import { naira } from "@/lib/money";
import { CashOut } from "./cash-out";
import {
  betPillClass,
  betStatusLabel,
  filterBets,
  OUTCOME_OPTIONS,
  type OutcomeFilter,
  type SerializedBetRow,
} from "./bets-filter";

export type { SerializedBetLeg, SerializedBetRow } from "./bets-filter";

export function BetsList({ bets }: { bets: SerializedBetRow[] }) {
  const [query, setQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("ALL");

  const filtered = useMemo(
    () => filterBets(bets, query, outcomeFilter),
    [bets, query, outcomeFilter],
  );

  const hasActiveFilter = query.trim().length > 0 || outcomeFilter !== "ALL";

  function clearFilters() {
    setQuery("");
    setOutcomeFilter("ALL");
  }

  return (
    <div className="sb-stack-3">
      <section className="sb-panel sb-bets-filter" aria-label="Filter bet history">
        <form
          className="sb-bets-searchrow"
          role="search"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="sb-bets-search">
            <label htmlFor="sb-bets-search" className="sb-sr">
              Search bets by team name or match outcome
            </label>
            <Search size={16} aria-hidden="true" className="sb-bets-search__icon" />
            <input
              id="sb-bets-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search team name or match outcome (e.g. Arsenal, Draw, Won)"
              autoComplete="off"
            />
            {query.length > 0 ? (
              <button
                type="button"
                className="sb-bets-search__clear"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X size={15} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </form>

        <div className="sb-chips sb-bets-filter__chips" role="group" aria-label="Filter by outcome">
          {OUTCOME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="sb-chip"
              aria-pressed={outcomeFilter === option.value}
              onClick={() => setOutcomeFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {hasActiveFilter ? (
          <div className="sb-bets-filter__meta">
            <span className="sb-small sb-muted" role="status" aria-live="polite">
              Showing {filtered.length} of {bets.length}{" "}
              {bets.length === 1 ? "bet" : "bets"}
            </span>
            <button
              type="button"
              className="sb-bets-filter__reset"
              onClick={clearFilters}
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </section>

      {filtered.length === 0 ? (
        <section className="sb-panel">
          <div className="sb-empty">
            <Ticket className="sb-empty__icon" size={28} aria-hidden="true" />
            <p className="sb-empty__title">No matching bets</p>
            <p className="sb-small">
              No bets match {query.trim() ? `“${query.trim()}”` : "the selected outcome"}. Try another
              team name or match outcome.
            </p>
            <p style={{ marginTop: "var(--sb-4)" }}>
              <button type="button" className="sb-btn sb-btn--ghost" onClick={clearFilters}>
                Clear filters
              </button>
            </p>
          </div>
        </section>
      ) : (
        <section className="sb-panel">
          {filtered.map((bet) => {
            const settled = bet.status !== "PENDING";
            const stakeMinor = BigInt(bet.stake_minor);
            const cashedOutStakeMinor = BigInt(bet.cashed_out_stake_minor ?? "0");
            const runningStakeMinor = stakeMinor - cashedOutStakeMinor;
            const runningReturnMinor =
              stakeMinor > 0n
                ? (BigInt(bet.potential_return_minor) * runningStakeMinor) / stakeMinor
                : 0n;
            const partiallyCashedOut = !settled && cashedOutStakeMinor > 0n;
            const paid =
              bet.status === "CASHED_OUT" && bet.cashout_value_minor
                ? bet.cashout_value_minor
                : bet.status === "WON"
                  ? bet.potential_return_minor
                  : bet.status === "VOID"
                    ? bet.stake_minor
                    : null;

            return (
              <article key={bet.id} className="sb-ticket">
                <div className="sb-ticket__head">
                  <span className={`sb-pill ${betPillClass(bet.status)}`}>
                    {betStatusLabel(bet.status)}
                  </span>
                  <span className="sb-small sb-muted">
                    {bet.legs.length > 1 ? `${bet.legs.length}-fold` : "Single"}
                  </span>
                  <time
                    className="sb-small sb-muted"
                    dateTime={new Date(bet.placed_at).toISOString()}
                    style={{ marginLeft: "auto" }}
                  >
                    {new Date(bet.placed_at).toLocaleString("en-NG", {
                      timeZone: "Africa/Lagos",
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>

                <div>
                  {bet.legs.map((leg, index) => (
                    <div className="sb-ticket__leg" key={index}>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ display: "block" }}>{leg.selection}</strong>
                        <span className="sb-xs sb-muted">{leg.fixture}</span>
                      </div>
                      <span
                        className="sb-ticket__legodds"
                        style={{ color: leg.result === "LOST" ? "var(--sb-faint)" : undefined }}
                      >
                        {Number(leg.odds).toFixed(2)}
                      </span>
                      {leg.result && leg.result !== "PENDING" ? (
                        <span className={`sb-pill ${betPillClass(leg.result)}`}>
                          {betStatusLabel(leg.result)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>

                <dl className="sb-ticket__foot">
                  <div>
                    <dt className="sb-xs sb-muted">{partiallyCashedOut ? "Still running" : "Stake"}</dt>
                    <dd style={{ margin: 0, fontWeight: 700 }}>
                      {naira(settled ? stakeMinor : runningStakeMinor)}
                    </dd>
                    {partiallyCashedOut ? (
                      <dd className="sb-xs sb-muted" style={{ margin: 0 }}>
                        {naira(cashedOutStakeMinor)} of {naira(stakeMinor)} cashed out
                      </dd>
                    ) : null}
                  </div>
                  <div>
                    <dt className="sb-xs sb-muted">Total odds</dt>
                    <dd style={{ margin: 0, fontWeight: 700 }}>
                      {Number(bet.total_odds_decimal).toFixed(2)}
                    </dd>
                  </div>
                  <div style={{ marginLeft: "auto", textAlign: "right" }}>
                    <dt className="sb-xs sb-muted">{settled ? "Returned" : "To return"}</dt>
                    <dd
                      style={{
                        margin: 0,
                        fontWeight: 800,
                        fontSize: "var(--sb-t-lg)",
                        color: paid && BigInt(paid) > 0n ? "var(--sb-up)" : undefined,
                      }}
                    >
                      {settled ? (paid ? naira(paid) : "—") : naira(runningReturnMinor)}
                    </dd>
                  </div>
                </dl>

                <p className="sb-ticket__ref">Reference {bet.id.slice(0, 8)}</p>

                {bet.status === "PENDING" ? (
                  <CashOut betId={bet.id} stakeMinor={bet.stake_minor} />
                ) : null}

                {bet.status === "CASHED_OUT" && bet.cashout_value_minor ? (
                  <p className="sb-note sb-note--ok" role="status">
                    <CheckCircle2 size={15} aria-hidden="true" />
                    Cashed out for <strong>{naira(bet.cashout_value_minor)}</strong>.
                  </p>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
