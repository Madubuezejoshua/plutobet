import Link from "next/link";
import { Flame } from "lucide-react";

/**
 * Date, kickoff-window, and Top-Leagues quick filters above the board.
 *
 * Real links with real query parameters, not client-side state that pretends
 * to filter. A filter the customer can bookmark and share is worth more than
 * one that resets on refresh, and it keeps the server the thing that decides
 * what is shown.
 */

export interface QuickLeagueItem {
  league: string;
  name: string;
  count: number;
}

export function DateStrip({
  active,
  sport,
  league,
  query,
  counts,
  topLeagues = [],
}: {
  active: "live" | "3h" | "today" | "all";
  sport: string;
  league?: string;
  query?: string;
  counts?: { all: number; live: number; next3h: number; today: number };
  topLeagues?: QuickLeagueItem[];
}) {
  const base = (params: Record<string, string | undefined>, keepLeague = true) => {
    const search = new URLSearchParams();
    if (sport && sport !== "football") search.set("sport", sport);
    if (keepLeague && league) search.set("league", league);
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    const qs = search.toString();
    return qs ? `/sports?${qs}` : "/sports";
  };

  return (
    <div className="sb-panel sb-filterpack" style={{ marginBottom: "var(--sb-3)" }}>
      <div className="sb-chips" role="group" aria-label="Filter fixtures by kickoff time">
        <Link href={base({})} className="sb-chip" aria-current={active === "all" ? "true" : undefined}>
          <span>All upcoming</span>
          {counts ? <span className="sb-chip__count">{counts.all}</span> : null}
        </Link>
        <Link
          href={base({ when: "live" })}
          className="sb-chip"
          aria-current={active === "live" ? "true" : undefined}
        >
          <span className="sb-live__dot" aria-hidden="true" />
          <span>Live now</span>
          {counts && counts.live > 0 ? <span className="sb-chip__count">{counts.live}</span> : null}
        </Link>
        <Link
          href={base({ when: "3h" })}
          className="sb-chip"
          aria-current={active === "3h" ? "true" : undefined}
        >
          <span>Next 3h</span>
          {counts ? <span className="sb-chip__count">{counts.next3h}</span> : null}
        </Link>
        <Link
          href={base({ when: "today" })}
          className="sb-chip"
          aria-current={active === "today" ? "true" : undefined}
        >
          <span>Today</span>
          {counts ? <span className="sb-chip__count">{counts.today}</span> : null}
        </Link>
        <Link href="/jackpot" className="sb-chip">
          Jackpot
        </Link>
        {league || query || active !== "all" ? (
          <Link
            href={sport && sport !== "football" ? `/sports?sport=${encodeURIComponent(sport)}` : "/sports"}
            className="sb-chip"
            aria-label="Clear all filters"
          >
            Clear filter
          </Link>
        ) : null}
      </div>

      {topLeagues.length > 0 ? (
        <nav className="sb-topleagues" aria-label="Top competitions">
          <span className="sb-topleagues__label">
            <Flame size={12} aria-hidden="true" />
            <span>Top Leagues</span>
          </span>
          <div className="sb-topleagues__list">
            {topLeagues.map((entry) => {
              const params = new URLSearchParams();
              if (sport && sport !== "football") params.set("sport", sport);
              params.set("league", entry.league);
              if (active !== "all") params.set("when", active);
              return (
                <Link
                  key={entry.league}
                  href={`/sports?${params.toString()}`}
                  className="sb-topleague"
                  aria-current={league === entry.league ? "true" : undefined}
                >
                  <span>{entry.name}</span>
                  <span className="sb-topleague__count">{entry.count}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
