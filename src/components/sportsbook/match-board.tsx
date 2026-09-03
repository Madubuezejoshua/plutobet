"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, ChevronDown, ChevronRight, Star, CalendarX } from "lucide-react";
import { OddsButton, type OddsState } from "./odds-button";
import { createIdSetStore, useBrowserStore } from "./browser-store";
import type { EventView, MarketView, SelectionView } from "@/modules/odds/odds.service";

/**
 * The odds board: league-grouped fixtures with their main markets.
 *
 * This is the primary content of the site, so it renders as a dense list of
 * real rows rather than a wall of cards. The previous homepage led with a
 * marketing hero and product tiles; a customer arriving to place a bet had to
 * scroll past all of it to reach a price.
 *
 * NOTHING HERE IS INVENTED. Scores render only when the event is genuinely
 * live and a score exists; the LIVE badge follows the stored status; a market
 * the provider did not send renders as unavailable rather than as a plausible
 * number.
 */

interface Props {
  events: EventView[];
  /** Shown while the server component is streaming. */
  loading?: boolean;
  emptyMessage?: string;
}

function marketFor(event: EventView, key: string): MarketView | undefined {
  return event.markets.find((m) => m.key === key);
}

function selectionFor(market: MarketView | undefined, key: string): SelectionView | undefined {
  return market?.selections.find((s) => s.key === key);
}

/**
 * The state a price is in.
 *
 * A market that exists but has no usable price is `suspended` — the provider
 * is still carrying the market and has pulled the price. A market that is not
 * present at all is `unavailable`. The two look different to a customer and
 * mean different things, so they are not collapsed together.
 */
function stateOf(market: MarketView | undefined, selection: SelectionView | undefined): OddsState {
  if (!market) return "unavailable";
  if (!selection) return "unavailable";
  if (!(selection.price > 1)) return "suspended";
  return "open";
}

function kickoff(iso: string): { time: string; day: string } {
  const date = new Date(iso);
  return {
    time: date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    day: date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
  };
}

/**
 * Starred fixtures.
 *
 * The star used to set component state and nothing else: it changed colour,
 * did not survive a navigation, and pinned nothing. A control that looks like
 * it remembers something and does not is worse than no control at all.
 *
 * Stored per browser rather than per account: this is a display preference, it
 * needs no route, no table and no migration, and losing it when someone clears
 * their browser costs them nothing.
 */
const favouriteMatches = createIdSetStore("local", "plutobet.favmatches.v1");

/** Splits "England - Premier League" into its parts for the group header. */
function splitLeague(label: string): { country: string | null; name: string } {
  const at = label.indexOf(" - ");
  if (at === -1) return { country: null, name: label };
  return { country: label.slice(0, at), name: label.slice(at + 3) };
}

export function MatchBoard({ events, loading = false, emptyMessage }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [favourites, setFavourites] = useBrowserStore(favouriteMatches);

  function toggleFavourite(eventId: string) {
    setFavourites(
      favourites.includes(eventId)
        ? favourites.filter((id) => id !== eventId)
        : [...favourites, eventId],
    );
  }

  const starred = useMemo(
    () => events.filter((event) => favourites.includes(event.id)),
    [events, favourites],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, EventView[]>();
    for (const event of events) {
      const list = map.get(event.league) ?? [];
      list.push(event);
      map.set(event.league, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);

  if (loading) return <BoardSkeleton />;

  if (events.length === 0) {
    return (
      <div className="sb-empty">
        <CalendarX className="sb-empty__icon" size={28} aria-hidden="true" />
        <p className="sb-empty__title">No fixtures to show</p>
        <p className="sb-small">
          {emptyMessage ?? "There are no matches with prices for this selection right now."}
        </p>
      </div>
    );
  }

  return (
    <div className="sb-board">
      {starred.length > 0 ? (
        <section className="sb-league">
          <h3 style={{ margin: 0 }}>
            <span className="sb-league__head" style={{ cursor: "default" }}>
              <Star size={14} aria-hidden="true" />
              <span>Your matches</span>
              <span className="sb-league__count">{starred.length}</span>
            </span>
          </h3>
          <div className="sb-cols" aria-hidden="true">
            <span>Match</span>
            <span className="sb-cols__odds">1</span>
            <span className="sb-cols__odds">X</span>
            <span className="sb-cols__odds">2</span>
            <span className="sb-cols__odds sb-cols__ou">Over</span>
            <span className="sb-cols__odds sb-cols__ou">Under</span>
            <span />
          </div>
          {starred.map((event) => (
            <EventRow
              key={`fav-${event.id}`}
              event={event}
              favourite
              onFavourite={() => toggleFavourite(event.id)}
            />
          ))}
        </section>
      ) : null}

      {grouped.map(([league, list]) => {
        const { country, name } = splitLeague(league);
        const isCollapsed = collapsed[league] ?? false;
        const panelId = `lg-${league.replace(/\W+/g, "-").toLowerCase()}`;

        return (
          <section className="sb-league" key={league}>
            <h3 style={{ margin: 0 }}>
              <button
                type="button"
                className="sb-league__head"
                aria-expanded={!isCollapsed}
                aria-controls={panelId}
                onClick={() => setCollapsed((c) => ({ ...c, [league]: !isCollapsed }))}
              >
                {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                {country ? <span className="sb-league__country">{country}</span> : null}
                <span>{name}</span>
                <span className="sb-league__count">{list.length}</span>
              </button>
            </h3>

            {!isCollapsed ? (
              <div id={panelId}>
                <div className="sb-cols" aria-hidden="true">
                  <span>Match</span>
                  <span className="sb-cols__odds">1</span>
                  <span className="sb-cols__odds">X</span>
                  <span className="sb-cols__odds">2</span>
                  <span className="sb-cols__odds sb-cols__ou">Over</span>
                  <span className="sb-cols__odds sb-cols__ou">Under</span>
                  <span />
                </div>

                {list.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    favourite={favourites.includes(event.id)}
                    onFavourite={() => toggleFavourite(event.id)}
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

function EventRow({
  event,
  favourite,
  onFavourite,
}: {
  event: EventView;
  favourite: boolean;
  onFavourite: () => void;
}) {
  const { time, day } = kickoff(event.startsAt);
  const live = event.status === "LIVE";

  const oneXTwo = marketFor(event, "1x2");
  const overUnder = marketFor(event, "over_under");

  const home = selectionFor(oneXTwo, "home");
  const draw = selectionFor(oneXTwo, "draw");
  const away = selectionFor(oneXTwo, "away");

  /*
   * The main Over/Under line. Providers send several; the 2.5 line is the one
   * customers expect on a board, and if it is absent the column shows
   * unavailable rather than silently substituting a different handicap — a
   * price for a line you did not choose is the wrong price.
   */
  const over = overUnder?.selections.find((s) => s.key === "over_2.5" || (s.key.startsWith("over") && s.line === 2.5));
  const under = overUnder?.selections.find((s) => s.key === "under_2.5" || (s.key.startsWith("under") && s.line === 2.5));

  const extraMarkets = Math.max(0, event.markets.length - 2);
  const fixture = `${event.home} v ${event.away}`;

  const pickFor = (market: MarketView | undefined, selection: SelectionView | undefined) =>
    market && selection
      ? {
          selectionId: selection.id,
          eventId: event.id,
          marketKey: market.key,
          selectionKey: selection.key,
          selectionLabel: selection.label,
          fixture,
          line: selection.line,
        }
      : undefined;

  return (
    <div className="sb-row">
      <div className="sb-fixture">
        <button
          type="button"
          className="sb-star"
          aria-pressed={favourite}
          aria-label={favourite ? `Remove ${fixture} from favourites` : `Add ${fixture} to favourites`}
          onClick={onFavourite}
        >
          <Star size={14} fill={favourite ? "currentColor" : "none"} aria-hidden="true" />
        </button>

        <span className="sb-fixture__time">
          {live ? (
            <span className="sb-live"><span className="sb-live__dot" />LIVE</span>
          ) : (
            <>
              {time}
              <br />
              <span className="sb-xs">{day}</span>
            </>
          )}
        </span>

        <span className="sb-fixture__teams">
          <span className="sb-fixture__team">{event.home}</span>
          <span className="sb-fixture__team">{event.away}</span>
        </span>

        <Link
          href={`/sports/event/${event.providerEventId}`}
          className="sb-pick__x sb-fixture__stats"
          aria-label={`Statistics and all markets for ${fixture}`}
        >
          <BarChart3 size={14} aria-hidden="true" />
        </Link>
      </div>

      <OddsButton label="1" price={home?.price ?? null} state={stateOf(oneXTwo, home)} pick={pickFor(oneXTwo, home)} />
      <OddsButton label="X" price={draw?.price ?? null} state={stateOf(oneXTwo, draw)} pick={pickFor(oneXTwo, draw)} />
      <OddsButton label="2" price={away?.price ?? null} state={stateOf(oneXTwo, away)} pick={pickFor(oneXTwo, away)} />
      <OddsButton className="sb-row__ou" label="O 2.5" price={over?.price ?? null} state={stateOf(overUnder, over)} pick={pickFor(overUnder, over)} />
      <OddsButton className="sb-row__ou" label="U 2.5" price={under?.price ?? null} state={stateOf(overUnder, under)} pick={pickFor(overUnder, under)} />

      {/*
        The link is always offered — the event page carries the full market
        list and the kick-off detail — but it only claims a COUNT when there is
        one. "+0" reads as a broken counter rather than as "no other markets".
      */}
      <Link
        href={`/sports/event/${event.providerEventId}`}
        className="sb-odd__more"
        aria-label={
          extraMarkets > 0
            ? `${extraMarkets} more markets for ${fixture}`
            : `All markets for ${fixture}`
        }
      >
        {extraMarkets > 0 ? `+${extraMarkets}` : <ChevronRight size={14} aria-hidden="true" />}
      </Link>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="sb-board" aria-busy="true" aria-live="polite">
      <span className="sb-sr">Loading fixtures</span>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div className="sb-row" key={i}>
          <div className="sb-fixture" style={{ gap: 8 }}>
            <div className="sb-skel" style={{ width: 40, height: 28 }} />
            <div style={{ flex: 1 }}>
              <div className="sb-skel" style={{ width: "60%", height: 11, marginBottom: 5 }} />
              <div className="sb-skel" style={{ width: "45%", height: 11 }} />
            </div>
          </div>
          <div className="sb-skel" style={{ height: 38 }} />
          <div className="sb-skel" style={{ height: 38 }} />
          <div className="sb-skel" style={{ height: 38 }} />
          <div className="sb-skel sb-row__ou" style={{ height: 38 }} />
          <div className="sb-skel sb-row__ou" style={{ height: 38 }} />
          <div className="sb-skel" style={{ height: 38 }} />
        </div>
      ))}
    </div>
  );
}
