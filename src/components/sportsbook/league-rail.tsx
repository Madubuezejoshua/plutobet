"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CalendarDays, Clock, Flame, Search, Star, Trophy } from "lucide-react";
import { createIdSetStore, useBrowserStore } from "./browser-store";

/**
 * Left navigation: search, time filters, favourites, competitions by country.
 *
 * Every league here is derived from fixtures that actually exist. A rail
 * listing competitions with nothing behind them sends customers to empty
 * pages, which reads as a broken site rather than a quiet week.
 *
 * FAVOURITES ARE REAL. They were briefly a star that toggled a colour and
 * forgot it on the next navigation — a control that looks like it does
 * something and does not. They now persist in `localStorage` and pin those
 * competitions to the top of the rail, which is the only thing a favourite
 * was ever supposed to mean here.
 *
 * They are deliberately per-browser rather than per-account: this is a display
 * preference, storing it needs no route, no table and no migration, and a
 * customer who clears their browser losing a starred league costs nothing.
 */

const favouriteLeagues = createIdSetStore("local", "plutobet.favleagues.v1");

export interface RailLeague {
  /** The stored label, e.g. "England - Premier League". */
  league: string;
  country: string | null;
  name: string;
  count: number;
}

export function LeagueRail({
  leagues,
  activeLeague,
  todayCount,
  upcomingCount,
}: {
  leagues: RailLeague[];
  activeLeague?: string;
  todayCount: number;
  upcomingCount: number;
}) {
  const [query, setQuery] = useState("");
  const [favourites, setFavourites] = useBrowserStore(favouriteLeagues);

  function toggleFavourite(league: string) {
    setFavourites(
      favourites.includes(league)
        ? favourites.filter((entry) => entry !== league)
        : [...favourites, league],
    );
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leagues;
    return leagues.filter(
      (l) => l.name.toLowerCase().includes(q) || (l.country ?? "").toLowerCase().includes(q),
    );
  }, [leagues, query]);

  const starred = useMemo(
    () => filtered.filter((l) => favourites.includes(l.league)),
    [filtered, favourites],
  );

  /*
   * "Popular" is a shortcut into a long list, so it only earns its place when
   * the list is actually long. On a board carrying five competitions it was
   * the same five names printed twice, one group above the other.
   */
  const popular = useMemo(() => {
    const rest = [...filtered].filter((l) => !favourites.includes(l.league));
    if (rest.length <= 8) return [];
    return rest.sort((a, b) => b.count - a.count).slice(0, 8);
  }, [filtered, favourites]);

  const byCountry = useMemo(() => {
    const map = new Map<string, RailLeague[]>();
    for (const l of filtered) {
      const key = l.country ?? "Other";
      map.set(key, [...(map.get(key) ?? []), l]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const leagueRow = (l: RailLeague, keyPrefix: string) => (
    <div key={`${keyPrefix}-${l.league}`} style={{ display: "flex", alignItems: "center" }}>
      <Link
        href={`/sports?league=${encodeURIComponent(l.league)}`}
        className="sb-railitem"
        aria-current={activeLeague === l.league ? "true" : undefined}
      >
        <Trophy size={15} className="sb-railitem__icon" aria-hidden="true" />
        <span className="sb-truncate">{l.name}</span>
        <span className="sb-railitem__count">{l.count}</span>
      </Link>
      <button
        type="button"
        className="sb-star"
        aria-pressed={favourites.includes(l.league)}
        aria-label={`${favourites.includes(l.league) ? "Remove" : "Add"} ${l.name} ${
          favourites.includes(l.league) ? "from" : "to"
        } favourites`}
        onClick={() => toggleFavourite(l.league)}
      >
        <Star
          size={13}
          fill={favourites.includes(l.league) ? "currentColor" : "none"}
          aria-hidden="true"
        />
      </button>
    </div>
  );

  return (
    <nav className="sb-panel" aria-label="Competitions">
      <div style={{ padding: 8, borderBottom: "1px solid var(--sb-border)" }}>
        <label className="sb-sr" htmlFor="sb-league-search">Search competitions</label>
        <div style={{ position: "relative" }}>
          <Search
            size={14}
            aria-hidden="true"
            style={{ position: "absolute", left: 9, top: 9, color: "var(--sb-faint)" }}
          />
          <input
            id="sb-league-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search competitions"
            style={{
              width: "100%", height: 32, paddingLeft: 28, paddingRight: 8,
              border: "1px solid var(--sb-border)", borderRadius: "var(--sb-r-md)",
              background: "var(--sb-surface-2)", color: "var(--sb-ink)",
              fontSize: "var(--sb-t-base)", fontFamily: "var(--sb-font)",
            }}
          />
        </div>
      </div>

      <div className="sb-rail__group">
        <Link href="/sports?when=today" className="sb-railitem">
          <Clock size={15} className="sb-railitem__icon" aria-hidden="true" />
          Today
          <span className="sb-railitem__count">{todayCount}</span>
        </Link>
        <Link href="/sports" className="sb-railitem">
          <CalendarDays size={15} className="sb-railitem__icon" aria-hidden="true" />
          Upcoming
          <span className="sb-railitem__count">{upcomingCount}</span>
        </Link>
        <Link href="/live" className="sb-railitem">
          <Flame size={15} className="sb-railitem__icon" aria-hidden="true" />
          Live now
        </Link>
      </div>

      {starred.length > 0 ? (
        <div className="sb-rail__group">
          <p className="sb-rail__label">Your competitions</p>
          {starred.map((l) => leagueRow(l, "fav"))}
        </div>
      ) : null}

      {popular.length > 0 ? (
        <div className="sb-rail__group">
          <p className="sb-rail__label">Popular</p>
          {popular.map((l) => leagueRow(l, "pop"))}
        </div>
      ) : null}

      {byCountry.map(([country, list]) => (
        <details key={country} className="sb-rail__group" open={list.length <= 4}>
          <summary className="sb-railitem" style={{ listStyle: "none", cursor: "pointer" }}>
            <span className="sb-truncate">{country}</span>
            <span className="sb-railitem__count">{list.length}</span>
          </summary>
          {list.map((l) => (
            <Link
              key={l.league}
              href={`/sports?league=${encodeURIComponent(l.league)}`}
              className="sb-railitem"
              style={{ paddingLeft: 28 }}
              aria-current={activeLeague === l.league ? "true" : undefined}
            >
              <span className="sb-truncate">{l.name}</span>
              <span className="sb-railitem__count">{l.count}</span>
            </Link>
          ))}
        </details>
      ))}

      {filtered.length === 0 ? (
        <p className="sb-pad sb-small sb-muted">No competitions match “{query}”.</p>
      ) : null}
    </nav>
  );
}
