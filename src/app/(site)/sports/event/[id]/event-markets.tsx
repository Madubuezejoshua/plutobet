"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, CalendarX } from "lucide-react";
import { OddsButton } from "@/components/sportsbook/odds-button";
import type { EventView, MarketView, SelectionView } from "@/modules/odds/odds.service";

/**
 * Match result (1X2: Home, Draw, Away) market view for a fixture.
 *
 * Handicap, Double Chance, Over/Under, and secondary markets are intentionally
 * omitted here so customers see only the Home / Draw / Away result options.
 */

const SELECTION_ORDER = ["home", "draw", "away"];

function orderedResultSelections(market: MarketView): SelectionView[] {
  return market.selections
    .filter((s) => SELECTION_ORDER.includes(s.key))
    .sort((a, b) => SELECTION_ORDER.indexOf(a.key) - SELECTION_ORDER.indexOf(b.key));
}

export function EventMarkets({ event }: { event: EventView }) {
  const [closed, setClosed] = useState(false);

  const resultMarket = event.markets.find((m) => m.key === "1x2");
  const selections = resultMarket ? orderedResultSelections(resultMarket) : [];

  if (!resultMarket || selections.length === 0) {
    return (
      <section className="sb-panel">
        <div className="sb-empty">
          <CalendarX className="sb-empty__icon" size={28} aria-hidden="true" />
          <p className="sb-empty__title">No match result odds available</p>
          <p className="sb-small">
            Home, Draw, and Away prices are not open on this fixture at the moment.
          </p>
        </div>
      </section>
    );
  }

  const fixture = `${event.home} v ${event.away}`;
  const hasDraw = selections.some((s) => s.key === "draw");
  const panelId = `mk-${resultMarket.id}`;

  return (
    <div className="sb-stack-3">
      <section className="sb-panel" key={resultMarket.id}>
        <h2 style={{ margin: 0 }}>
          <button
            type="button"
            className="sb-league__head"
            aria-expanded={!closed}
            aria-controls={panelId}
            onClick={() => setClosed((c) => !c)}
          >
            {closed ? (
              <ChevronRight size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
            <span>{hasDraw ? "Match result (Home / Draw / Away)" : "Match result (Home / Away)"}</span>
            <span className="sb-league__count">{selections.length}</span>
          </button>
        </h2>

        {!closed ? (
          <div id={panelId} className="sb-marketgrid sb-marketgrid--1x2">
            {selections.map((selection) => (
              <OddsButton
                key={selection.id}
                label={selection.label}
                price={selection.price}
                state={selection.price > 1 ? "open" : "suspended"}
                pick={{
                  selectionId: selection.id,
                  eventId: event.id,
                  marketKey: resultMarket.key,
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
    </div>
  );
}
