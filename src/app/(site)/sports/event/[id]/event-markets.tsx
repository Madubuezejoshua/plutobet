"use client";

import { useMemo, useState } from "react";
import { CalendarX, ChevronDown, ChevronRight } from "lucide-react";
import { OddsButton } from "@/components/sportsbook/odds-button";
import type { EventView, MarketView, SelectionView } from "@/modules/odds/odds.service";

/**
 * Full fixture market board with clean category tabs.
 *
 * Match Result (1X2) is always pinned first so customers find Home / Draw / Away
 * immediately, while Double Chance, Over/Under Goals, Both Teams to Score,
 * Handicaps, Half-Time/Full-Time, and Correct Score remain one tap away via
 * category filter tabs or by scrolling down under All Markets.
 */

type CategoryKey = "all" | "main" | "goals" | "handicap" | "specials";

interface MarketMeta {
  title: string;
  category: Exclude<CategoryKey, "all">;
  order: number;
}

const MARKET_META: Record<string, MarketMeta> = {
  "1x2": { title: "Match Result (1X2)", category: "main", order: 1 },
  double_chance: { title: "Double Chance", category: "main", order: 2 },
  btts: { title: "Both Teams to Score", category: "goals", order: 3 },
  over_under: { title: "Total Goals (Over / Under)", category: "goals", order: 4 },
  handicap: { title: "Handicap", category: "handicap", order: 5 },
  ht_ft: { title: "Half-Time / Full-Time", category: "specials", order: 6 },
  correct_score: { title: "Correct Score", category: "specials", order: 7 },
};

const CATEGORY_TABS: { key: CategoryKey; label: string }[] = [
  { key: "all", label: "All Markets" },
  { key: "main", label: "Main (1X2 & DC)" },
  { key: "goals", label: "Goals & BTTS" },
  { key: "handicap", label: "Handicaps" },
  { key: "specials", label: "Specials" },
];

const ONE_X_TWO_ORDER = ["home", "draw", "away"];
const DC_ORDER = ["1x", "12", "x2"];
const BTTS_ORDER = ["yes", "no"];

function humanizeMarketKey(key: string): string {
  return key
    .split(/[_\-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getMarketMeta(market: MarketView): MarketMeta {
  const known = MARKET_META[market.key];
  if (known) return known;
  return {
    title: humanizeMarketKey(market.key),
    category: "specials",
    order: 50,
  };
}

function sortSelections(market: MarketView): SelectionView[] {
  const items = [...market.selections];
  if (market.key === "1x2") {
    return items.sort((a, b) => {
      const ia = ONE_X_TWO_ORDER.indexOf(a.key);
      const ib = ONE_X_TWO_ORDER.indexOf(b.key);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }
  if (market.key === "double_chance") {
    return items.sort((a, b) => {
      const ia = DC_ORDER.indexOf(a.key);
      const ib = DC_ORDER.indexOf(b.key);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }
  if (market.key === "btts") {
    return items.sort((a, b) => {
      const ia = BTTS_ORDER.indexOf(a.key);
      const ib = BTTS_ORDER.indexOf(b.key);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }
  if (market.key === "over_under") {
    return items.sort((a, b) => {
      const lineDiff = (a.line ?? 0) - (b.line ?? 0);
      if (lineDiff !== 0) return lineDiff;
      return a.key.startsWith("over") ? -1 : 1;
    });
  }
  if (market.key === "handicap") {
    return items.sort((a, b) => {
      const absDiff = Math.abs(a.line ?? 0) - Math.abs(b.line ?? 0);
      if (absDiff !== 0) return absDiff;
      return a.key.startsWith("home") ? -1 : 1;
    });
  }
  return items;
}

interface LinePair {
  lineLabel: string;
  over: SelectionView | null;
  under: SelectionView | null;
}

function groupOverUnderByLine(selections: SelectionView[]): LinePair[] {
  const map = new Map<string, LinePair>();
  for (const sel of selections) {
    const lineValue = sel.line ?? null;
    const key = lineValue !== null ? String(lineValue) : sel.label;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        lineLabel: lineValue !== null ? lineValue.toFixed(1).replace(/\.0$/, ".0") : "",
        over: null,
        under: null,
      };
      map.set(key, entry);
    }
    if (sel.key.startsWith("over") || sel.label.toLowerCase().includes("over")) {
      entry.over = sel;
    } else if (sel.key.startsWith("under") || sel.label.toLowerCase().includes("under")) {
      entry.under = sel;
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, pair]) => pair)
    .filter((pair) => pair.over !== null || pair.under !== null);
}

export function EventMarkets({ event }: { event: EventView }) {
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const orderedMarkets = useMemo(() => {
    return [...event.markets]
      .filter((m) => m.selections.length > 0)
      .sort((a, b) => {
        const ma = getMarketMeta(a);
        const mb = getMarketMeta(b);
        if (ma.order !== mb.order) return ma.order - mb.order;
        return ma.title.localeCompare(mb.title);
      });
  }, [event.markets]);

  const availableTabs = useMemo(() => {
    const counts: Record<CategoryKey, number> = {
      all: orderedMarkets.length,
      main: 0,
      goals: 0,
      handicap: 0,
      specials: 0,
    };
    for (const market of orderedMarkets) {
      counts[getMarketMeta(market).category] += 1;
    }
    return CATEGORY_TABS.filter((tab) => tab.key === "all" || counts[tab.key] > 0).map((tab) => ({
      ...tab,
      count: counts[tab.key],
    }));
  }, [orderedMarkets]);

  const visibleMarkets = useMemo(() => {
    if (activeCategory === "all") return orderedMarkets;
    return orderedMarkets.filter((m) => getMarketMeta(m).category === activeCategory);
  }, [orderedMarkets, activeCategory]);

  if (orderedMarkets.length === 0) {
    return (
      <section className="sb-panel">
        <div className="sb-empty">
          <CalendarX className="sb-empty__icon" size={28} aria-hidden="true" />
          <p className="sb-empty__title">No open markets available</p>
          <p className="sb-small">
            Markets for this fixture are currently suspended or closed. Check back closer to kick-off.
          </p>
        </div>
      </section>
    );
  }

  const fixture = `${event.home} v ${event.away}`;

  function toggleMarket(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="sb-stack-3">
      {availableTabs.length > 1 ? (
        <div className="sb-chips" role="tablist" aria-label="Market categories">
          {availableTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeCategory === tab.key}
              className="sb-chip"
              onClick={() => setActiveCategory(tab.key)}
            >
              <span>{tab.label}</span>
              <span className="sb-chip__count">{tab.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {visibleMarkets.map((market) => {
        const meta = getMarketMeta(market);
        const selections = sortSelections(market);
        const isClosed = Boolean(collapsed[market.id]);
        const panelId = `mk-${market.id}`;

        const headingTitle =
          market.key === "1x2"
            ? selections.some((s) => s.key === "draw")
              ? "Match Result (Home / Draw / Away)"
              : "Match Winner (Home / Away)"
            : meta.title;

        const isOverUnder = market.key === "over_under";
        const ouPairs = isOverUnder ? groupOverUnderByLine(selections) : [];
        const gridClass =
          market.key === "1x2" || market.key === "double_chance"
            ? "sb-marketgrid sb-marketgrid--1x2"
            : market.key === "btts" || market.key === "handicap"
              ? "sb-marketgrid sb-marketgrid--2col"
              : "sb-marketgrid";

        return (
          <section className="sb-panel" key={market.id}>
            <h2 style={{ margin: 0 }}>
              <button
                type="button"
                className="sb-league__head"
                aria-expanded={!isClosed}
                aria-controls={panelId}
                onClick={() => toggleMarket(market.id)}
              >
                {isClosed ? (
                  <ChevronRight size={14} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} aria-hidden="true" />
                )}
                <span>{headingTitle}</span>
                <span className="sb-league__count">{selections.length}</span>
              </button>
            </h2>

            {!isClosed ? (
              isOverUnder && ouPairs.length > 0 ? (
                <div id={panelId} className="sb-ou-list">
                  <div className="sb-ou-head" aria-hidden="true">
                    <span>Line</span>
                    <span>Over</span>
                    <span>Under</span>
                  </div>
                  {ouPairs.map((pair) => (
                    <div key={pair.lineLabel} className="sb-ou-row">
                      <span className="sb-ou-line sb-num">{pair.lineLabel}</span>
                      {pair.over ? (
                        <OddsButton
                          label={pair.over.label}
                          price={pair.over.price}
                          state={pair.over.price > 1 ? "open" : "suspended"}
                          pick={{
                            selectionId: pair.over.id,
                            eventId: event.id,
                            marketKey: market.key,
                            selectionKey: pair.over.key,
                            selectionLabel: pair.over.label,
                            fixture,
                            line: pair.over.line,
                          }}
                        />
                      ) : (
                        <span className="sb-ou-empty">—</span>
                      )}
                      {pair.under ? (
                        <OddsButton
                          label={pair.under.label}
                          price={pair.under.price}
                          state={pair.under.price > 1 ? "open" : "suspended"}
                          pick={{
                            selectionId: pair.under.id,
                            eventId: event.id,
                            marketKey: market.key,
                            selectionKey: pair.under.key,
                            selectionLabel: pair.under.label,
                            fixture,
                            line: pair.under.line,
                          }}
                        />
                      ) : (
                        <span className="sb-ou-empty">—</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div id={panelId} className={gridClass}>
                  {selections.map((selection) => (
                    <OddsButton
                      key={selection.id}
                      label={selection.label}
                      price={selection.price}
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
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
