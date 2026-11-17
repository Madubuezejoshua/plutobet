"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, CalendarX } from "lucide-react";
import { OddsButton } from "@/components/sportsbook/odds-button";
import type { EventView, MarketView } from "@/modules/odds/odds.service";

/**
 * Every open market on one fixture, each collapsible.
 *
 * Market keys arrive from the provider as machine names (`over_under`,
 * `btts`). They are given readable titles where we know them and are
 * title-cased otherwise — never dropped, and never renamed to something we
 * are only guessing at. Showing `asian_handicap_1` is honest; calling it
 * "Handicap" when it might be a different line is not.
 */

const MARKET_TITLES: Record<string, string> = {
  "1x2": "Match result",
  over_under: "Total goals",
  btts: "Both teams to score",
  double_chance: "Double chance",
  draw_no_bet: "Draw no bet",
  correct_score: "Correct score",
  half_time_result: "Half time result",
  first_half_over_under: "First half goals",
};

function titleFor(key: string): string {
  const known = MARKET_TITLES[key];
  if (known) return known;
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The order a customer expects: result first, then goals, then the rest. */
const PRIORITY = ["1x2", "over_under", "btts", "double_chance", "draw_no_bet"];

function rank(key: string): number {
  const at = PRIORITY.indexOf(key);
  return at === -1 ? PRIORITY.length : at;
}

export function EventMarkets({ event }: { event: EventView }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const markets = [...event.markets].sort(
    (a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key),
  );

  if (markets.length === 0) {
    return (
      <section className="sb-panel">
        <div className="sb-empty">
          <CalendarX className="sb-empty__icon" size={28} aria-hidden="true" />
          <p className="sb-empty__title">No open markets</p>
          <p className="sb-small">
            Nothing is priced on this fixture at the moment. Prices usually appear closer to
            kick-off.
          </p>
        </div>
      </section>
    );
  }

  const fixture = `${event.home} v ${event.away}`;

  return (
    <div className="sb-stack-3">
      {markets.map((market: MarketView) => {
        const isClosed = closed[market.id] ?? false;
        const panelId = `mk-${market.id}`;

        return (
          <section className="sb-panel" key={market.id}>
            <h2 style={{ margin: 0 }}>
              <button
                type="button"
                className="sb-league__head"
                aria-expanded={!isClosed}
                aria-controls={panelId}
                onClick={() => setClosed((c) => ({ ...c, [market.id]: !isClosed }))}
              >
                {isClosed ? (
                  <ChevronRight size={14} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} aria-hidden="true" />
                )}
                <span>{titleFor(market.key)}</span>
                <span className="sb-league__count">{market.selections.length}</span>
              </button>
            </h2>

            {!isClosed ? (
              <div id={panelId} className="sb-marketgrid">
                {market.selections.map((selection) => (
                  <OddsButton
                    key={selection.id}
                    label={
                      selection.line === null
                        ? selection.label
                        : `${selection.label} ${selection.line}`
                    }
                    price={selection.price}
                    /*
                     * A selection reaching this page is already OPEN — the
                     * query filters on it — so the only distinction left is
                     * whether it carries a usable price.
                     */
                    state={selection.price > 1 ? "open" : "suspended"}
                    pick={{
                      selectionId: selection.id,
                      eventId: event.id,
                      marketKey: market.key,
                      selectionKey: selection.key,
                      selectionLabel: selection.label,
                      fixture,
                      line: selection.line,
                    }}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
