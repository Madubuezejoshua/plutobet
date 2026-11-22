"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { BarChart3, ChevronDown, ChevronRight, Star, CalendarX } from "lucide-react";
import { OddsButton, type OddsState } from "./odds-button";
import { createIdSetStore, useBrowserStore } from "./browser-store";
import type { EventView, MarketView, SelectionView } from "@/modules/odds/odds.service";
import { SPORT_BY_KEY } from "@/modules/odds/sports-catalog";

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
  sport?: string;
  teamBadges?: Record<string, string>;
  /** Shown while the server component is streaming. */
  loading?: boolean;
  emptyMessage?: string;
}

function ClubCrest({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;

  return (
    <Image
      src={src}
      alt=""
      width={16}
      height={16}
      referrerPolicy="no-referrer"
      className="sb-fixture__crest"
      onError={() => setFailed(true)}
    />
  );
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

const BOARD_DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function kickoff(iso: string): { time: string; day: string } {
  const parts = BOARD_DATE_FMT.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    time: `${get("hour")}:${get("minute")}`,
    day: `${get("day")} ${get("month")}`,
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

export function MatchBoard({ events, sport, teamBadges, loading = false, emptyMessage }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [favourites, setFavourites] = useBrowserStore(favouriteMatches);

  function toggleFavourite(eventId: string) {
    setFavourites(
      favourites.includes(eventId)
        ? favourites.filter((id) => id !== eventId)
        : [...favourites, eventId],
    );
  }

  const hasAnyDraw = useMemo(
    () =>
      events.some((event) =>
        Boolean(selectionFor(marketFor(event, "1x2"), "draw")),
      ),
    [events],
  );
  const twoWayDefault = sport ? (SPORT_BY_KEY[sport]?.twoWayDefault ?? false) : false;
  const isTwoWay = Boolean((twoWayDefault || (sport && sport !== "football")) && !hasAnyDraw);

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
    return [...map.entries()].sort((a, b) => {
      const aPriced = a[1].some((ev) => ev.markets.length > 0) ? 0 : 1;
      const bPriced = b[1].some((ev) => ev.markets.length > 0) ? 0 : 1;
      if (aPriced !== bPriced) return aPriced - bPriced;
      return a[0].localeCompare(b[0]);
    });
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

  const showingStarredOnly = onlyStarred && starred.length > 0;

  return (
    <div className={isTwoWay ? "sb-board sb-board--2way" : "sb-board"}>
      {starred.length > 0 ? (
        <div className="sb-board-filterbar" role="group" aria-label="Match view filter">
          <div className="sb-chips">
            <button
              type="button"
              className="sb-chip"
              aria-pressed={!showingStarredOnly}
              onClick={() => setOnlyStarred(false)}
            >
              <span>All matches</span>
              <span className="sb-chip__count">{events.length}</span>
            </button>
            <button
              type="button"
              className="sb-chip"
              aria-pressed={showingStarredOnly}
              onClick={() => setOnlyStarred(true)}
            >
              <Star size={13} aria-hidden="true" />
              <span>Starred</span>
              <span className="sb-chip__count">{starred.length}</span>
            </button>
          </div>
          {showingStarredOnly ? (
            <button
              type="button"
              className="sb-board-clearstars"
              onClick={() => {
                setFavourites([]);
                setOnlyStarred(false);
              }}
            >
              Clear stars
            </button>
          ) : null}
        </div>
      ) : null}

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
            {!isTwoWay ? <span className="sb-cols__odds">X</span> : null}
            <span className="sb-cols__odds">2</span>
            <span className="sb-cols__odds sb-cols__ou">Over</span>
            <span className="sb-cols__odds sb-cols__ou">Under</span>
            <span />
          </div>
          {starred.map((event) => (
            <EventRow
              key={`fav-${event.id}`}
              event={event}
              isTwoWay={isTwoWay}
              teamBadges={teamBadges}
              favourite
              onFavourite={() => toggleFavourite(event.id)}
            />
          ))}
        </section>
      ) : null}

      {!showingStarredOnly && grouped.map(([league, list]) => {
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
                  {!isTwoWay ? <span className="sb-cols__odds">X</span> : null}
                  <span className="sb-cols__odds">2</span>
                  <span className="sb-cols__odds sb-cols__ou">Over</span>
                  <span className="sb-cols__odds sb-cols__ou">Under</span>
                  <span />
                </div>

                {list.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    isTwoWay={isTwoWay}
                    teamBadges={teamBadges}
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

function primaryOverUnder(
  market: MarketView | undefined,
  sport: string,
): { over?: SelectionView; under?: SelectionView; lineLabel: string } {
  if (!market || market.selections.length === 0) {
    return { lineLabel: sport === "football" ? "2.5" : "" };
  }

  // Football always pins the canonical 2.5 goals line on the board.
  if (sport === "football") {
    const over = market.selections.find(
      (s) => s.key === "over_2.5" || (s.key.startsWith("over") && s.line === 2.5),
    );
    const under = market.selections.find(
      (s) => s.key === "under_2.5" || (s.key.startsWith("under") && s.line === 2.5),
    );
    return { over, under, lineLabel: "2.5" };
  }

  // Non-football totals (e.g. Basketball 221.5 pts) have sport-specific lines:
  // pick the most balanced paired line (smallest |over.price - under.price|)
  // and display its exact line number on both buttons.
  const pairs = new Map<number, { over?: SelectionView; under?: SelectionView }>();
  for (const sel of market.selections) {
    if (sel.line === null || !Number.isFinite(sel.line)) continue;
    const entry = pairs.get(sel.line) ?? {};
    if (sel.key.startsWith("over")) entry.over = sel;
    else if (sel.key.startsWith("under")) entry.under = sel;
    pairs.set(sel.line, entry);
  }

  let bestLine: number | null = null;
  let bestPair: { over?: SelectionView; under?: SelectionView } | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const [line, pair] of pairs.entries()) {
    if (!pair.over || !pair.under) continue;
    const diff = Math.abs(pair.over.price - pair.under.price);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestLine = line;
      bestPair = pair;
    }
  }

  if (bestPair && bestLine !== null) {
    return { over: bestPair.over, under: bestPair.under, lineLabel: String(bestLine) };
  }
  return { lineLabel: "" };
}

function EventRow({
  event,
  isTwoWay,
  teamBadges,
  favourite,
  onFavourite,
}: {
  event: EventView;
  isTwoWay: boolean;
  teamBadges?: Record<string, string>;
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

  const { over, under, lineLabel } = primaryOverUnder(overUnder, event.sport);

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

        <Link
          href={`/sports/event/${event.providerEventId}`}
          className="sb-fixture__teams sb-fixture__teamslink"
        >
          <span className="sb-fixture__team">
            <ClubCrest key={teamBadges?.[event.home] ?? "hnone"} src={teamBadges?.[event.home]} />
            <span className="sb-fixture__teamname">{event.home}</span>
          </span>
          <span className="sb-fixture__team">
            <ClubCrest key={teamBadges?.[event.away] ?? "anone"} src={teamBadges?.[event.away]} />
            <span className="sb-fixture__teamname">{event.away}</span>
          </span>
        </Link>

        <Link
          href={`/sports/event/${event.providerEventId}`}
          className="sb-pick__x sb-fixture__stats"
          aria-label={`Match result odds for ${fixture}`}
        >
          <BarChart3 size={14} aria-hidden="true" />
        </Link>
      </div>

      <OddsButton label="1" price={home?.price ?? null} state={stateOf(oneXTwo, home)} pick={pickFor(oneXTwo, home)} />
      {!isTwoWay ? (
        <OddsButton label="X" price={draw?.price ?? null} state={stateOf(oneXTwo, draw)} pick={pickFor(oneXTwo, draw)} />
      ) : null}
      <OddsButton label="2" price={away?.price ?? null} state={stateOf(oneXTwo, away)} pick={pickFor(oneXTwo, away)} />
      <OddsButton className="sb-row__ou" label={lineLabel ? `O ${lineLabel}` : "Over"} price={over?.price ?? null} state={stateOf(overUnder, over)} pick={pickFor(overUnder, over)} />
      <OddsButton className="sb-row__ou" label={lineLabel ? `U ${lineLabel}` : "Under"} price={under?.price ?? null} state={stateOf(overUnder, under)} pick={pickFor(overUnder, under)} />

      <Link
        href={`/sports/event/${event.providerEventId}`}
        className="sb-odd__more"
        aria-label={
          event.markets.length > 1
            ? `${event.markets.length} markets for ${fixture}`
            : `All markets for ${fixture}`
        }
      >
        {event.markets.length > 1 ? `+${event.markets.length - 1}` : null}
        <ChevronRight size={14} aria-hidden="true" />
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
