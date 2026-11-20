import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { events, markets, oddsSnapshots, selections } from "./schema";
import type { OddsSnapshot } from "./provider";
import { SPORTS_CATALOG, leaguePriority } from "./sports-catalog";

/**
 * The read path. Everything user-facing goes through here.
 *
 * This module has NO reference to OddsProvider and never will — that is the
 * Phase 2 acceptance criterion: 500 concurrent users browsing odds trigger
 * zero upstream API calls. Only OddsSyncService talks upstream, and a miss
 * here means stale-or-nothing, never a provider call.
 */

/**
 * Explicit view types rather than leaking row types. Prices come out of
 * Drizzle's NUMERIC columns as strings; converting once here means callers
 * (and the socket layer in a later phase) get one stable shape instead of
 * each deciding how to parse.
 */
export interface SelectionView {
  id: string;
  key: string;
  label: string;
  line: number | null;
  price: number;
}

export interface MarketView {
  id: string;
  key: string;
  selections: SelectionView[];
}

export interface EventView {
  id: string;
  providerEventId: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  startsAt: string;
  status: string;
  markets: MarketView[];
}

export interface SportCountSummary {
  upcoming: number;
  live: number;
}

/**
 * Single grouped read returning active upcoming + in-play counts per sport.
 * Used by the shell navigation, A–Z sports sidebar, and live tabs without
 * issuing N separate queries per sport.
 */
export async function getSportCounts(): Promise<Record<string, SportCountSummary>> {
  const rows = await db.execute<{ sport: string; upcoming: number; live: number }>(sql`
    SELECT
      sport,
      count(*) FILTER (
        WHERE (status = 'PENDING' AND starts_at >= now())
           OR (status = 'LIVE' AND starts_at >= now() - INTERVAL '4 hours')
      )::int AS upcoming,
      count(*) FILTER (
        WHERE status = 'LIVE' AND starts_at >= now() - INTERVAL '4 hours'
      )::int AS live
    FROM events
    WHERE (status = 'PENDING' AND starts_at >= now())
       OR (status = 'LIVE' AND starts_at >= now() - INTERVAL '4 hours')
    GROUP BY sport
  `);

  const out: Record<string, SportCountSummary> = {};
  for (const row of rows) {
    out[row.sport] = { upcoming: Number(row.upcoming ?? 0), live: Number(row.live ?? 0) };
  }
  return out;
}

/** Newest stored snapshot for one event. Never calls upstream. */
export async function getEventOdds(providerEventId: string): Promise<OddsSnapshot | null> {
  const [row] = await db
    .select()
    .from(oddsSnapshots)
    .where(eq(oddsSnapshots.providerEventId, providerEventId))
    .orderBy(desc(oddsSnapshots.fetchedAt))
    .limit(1);

  if (!row) return null;

  return {
    eventId: row.providerEventId,
    books: row.payload as OddsSnapshot["books"],
    fetchedAt: row.fetchedAt,
  };
}

/**
 * Upcoming fixtures with their currently-open markets.
 *
 * One query with a join rather than N+1 per event: browsing is the hottest
 * read in the product, and issuing a query per fixture is what turns a busy
 * Saturday into a database incident.
 */
export async function listUpcoming(opts?: {
  sport?: string;
  /** Filter to one competition, by `competitions.id`. */
  competitionId?: string;
  limit?: number;
}): Promise<EventView[]> {
  const limit = opts?.limit ?? 50;

  const upcoming = await db
    .select()
    .from(events)
    .where(
      and(
        opts?.sport ? eq(events.sport, opts.sport) : undefined,
        opts?.competitionId ? eq(events.competitionId, opts.competitionId) : undefined,
        or(
          and(eq(events.status, "PENDING"), gte(events.startsAt, new Date())),
          and(
            eq(events.status, "LIVE"),
            gte(events.startsAt, new Date(Date.now() - 4 * 60 * 60_000)),
          ),
        ),
      ),
    )
    .orderBy(asc(events.startsAt))
    .limit(limit);

  if (upcoming.length === 0) return [];

  const rows = await db
    .select({
      eventId: markets.eventId,
      marketId: markets.id,
      marketKey: markets.key,
      selectionId: selections.id,
      selectionKey: selections.key,
      label: selections.label,
      line: selections.line,
      price: selections.currentPriceDecimal,
    })
    .from(markets)
    .innerJoin(selections, eq(selections.marketId, markets.id))
    .where(
      and(
        inArray(
          markets.eventId,
          upcoming.map((e) => e.id),
        ),
        eq(markets.status, "OPEN"),
        eq(selections.status, "OPEN"),
      ),
    );

  const byEvent = new Map<string, Map<string, MarketView>>();
  for (const row of rows) {
    let eventMarkets = byEvent.get(row.eventId);
    if (!eventMarkets) {
      eventMarkets = new Map();
      byEvent.set(row.eventId, eventMarkets);
    }
    let market = eventMarkets.get(row.marketId);
    if (!market) {
      market = { id: row.marketId, key: row.marketKey, selections: [] };
      eventMarkets.set(row.marketId, market);
    }
    market.selections.push({
      id: row.selectionId,
      key: row.selectionKey,
      label: row.label,
      line: row.line === null ? null : Number(row.line),
      price: Number(row.price),
    });
  }

  return upcoming.map((e) => ({
    id: e.id,
    providerEventId: e.providerEventId,
    sport: e.sport,
    league: e.league,
    home: e.home,
    away: e.away,
    startsAt: e.startsAt.toISOString(),
    status: e.status,
    markets: [...(byEvent.get(e.id)?.values() ?? [])],
  }));
}

/**
 * One fixture with every open market, for the event page.
 *
 * Added because the match board linked to `/sports/event/<id>` and that page
 * did not exist: two dead links on every row of the board. Building the page
 * needed a read that returns ALL markets for one event rather than the three
 * the board shows.
 *
 * Same rules as `listUpcoming`: stored data only, never a provider call, and
 * only markets and selections that are OPEN. A closed market is absent rather
 * than shown without a price, so the caller can tell "no such market" from
 * "market present, price withheld" — a distinction the odds tile relies on.
 */
export async function getEventView(providerEventId: string): Promise<EventView | null> {
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.providerEventId, providerEventId))
    .limit(1);

  if (!event) return null;

  const rows = await db
    .select({
      marketId: markets.id,
      marketKey: markets.key,
      selectionId: selections.id,
      selectionKey: selections.key,
      label: selections.label,
      line: selections.line,
      price: selections.currentPriceDecimal,
    })
    .from(markets)
    .innerJoin(selections, eq(selections.marketId, markets.id))
    .where(
      and(
        eq(markets.eventId, event.id),
        eq(markets.status, "OPEN"),
        eq(selections.status, "OPEN"),
      ),
    );

  const byMarket = new Map<string, MarketView>();
  for (const row of rows) {
    let market = byMarket.get(row.marketId);
    if (!market) {
      market = { id: row.marketId, key: row.marketKey, selections: [] };
      byMarket.set(row.marketId, market);
    }
    market.selections.push({
      id: row.selectionId,
      key: row.selectionKey,
      label: row.label,
      line: row.line === null ? null : Number(row.line),
      price: Number(row.price),
    });
  }

  return {
    id: event.id,
    providerEventId: event.providerEventId,
    sport: event.sport,
    league: event.league,
    home: event.home,
    away: event.away,
    startsAt: event.startsAt.toISOString(),
    status: event.status,
    markets: [...byMarket.values()],
  };
}

export interface HotShowcaseEvent extends EventView {
  homeScore: number | null;
  awayScore: number | null;
}

export interface SportHotCategory {
  sport: string;
  label: string;
  shortLabel: string;
  twoWayDefault: boolean;
  liveCount: number;
  upcomingCount: number;
  events: HotShowcaseEvent[];
}

type RankedShowcaseRow = {
  id: string;
  provider_event_id: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  starts_at: Date;
  status: string;
  home_score: number | null;
  away_score: number | null;
};

/**
 * Multi-sport Live & Hot Games showcase query.
 *
 * Uses a single partitioned SQL read (no N+1 per sport, zero upstream provider
 * calls) to fetch up to `perSport` top fixtures for every active sport in
 * `SPORTS_CATALOG`, ranking LIVE matches first, then priced upcoming fixtures
 * and marquee leagues.
 */
export async function listHotShowcaseBySport(opts?: {
  perSport?: number;
  liveOnly?: boolean;
}): Promise<SportHotCategory[]> {
  const perSport = Math.max(2, Math.min(opts?.perSport ?? 8, 12));
  const liveOnly = opts?.liveOnly ?? false;

  const [counts, ranked] = await Promise.all([
    getSportCounts().catch(() => ({} as Record<string, SportCountSummary>)),
    db.execute<RankedShowcaseRow>(sql`
      WITH candidates AS (
        SELECT
          e.id,
          e.provider_event_id,
          e.sport,
          e.league,
          e.home,
          e.away,
          e.starts_at,
          e.status::text AS status,
          (r.periods -> 'ft' ->> 'home')::int AS home_score,
          (r.periods -> 'ft' ->> 'away')::int AS away_score,
          EXISTS (
            SELECT 1 FROM markets m
            WHERE m.event_id = e.id AND m.status = 'OPEN'
          ) AS has_price
        FROM events e
        LEFT JOIN LATERAL (
          SELECT er.periods FROM event_results er
          WHERE er.event_id = e.id ORDER BY er.ingested_at DESC LIMIT 1
        ) r ON true
        WHERE ${
          liveOnly
            ? sql`e.status = 'LIVE' AND e.starts_at >= now() - INTERVAL '4 hours'`
            : sql`(e.status = 'LIVE' AND e.starts_at >= now() - INTERVAL '4 hours')
                  OR (e.status = 'PENDING' AND e.starts_at >= now())`
        }
      ),
      ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY sport
            ORDER BY
              CASE WHEN status = 'LIVE' THEN 0 ELSE 1 END,
              CASE WHEN has_price THEN 0 ELSE 1 END,
              starts_at ASC
          ) AS rn
        FROM candidates
      )
      SELECT
        id::text AS id,
        provider_event_id,
        sport,
        league,
        home,
        away,
        starts_at,
        status,
        home_score,
        away_score
      FROM ranked
      WHERE rn <= ${perSport}
      ORDER BY sport, rn
    `),
  ]);

  if (ranked.length === 0) return [];

  const eventIds = ranked.map((r) => r.id);
  const marketRows = await db
    .select({
      eventId: markets.eventId,
      marketId: markets.id,
      marketKey: markets.key,
      selectionId: selections.id,
      selectionKey: selections.key,
      label: selections.label,
      line: selections.line,
      price: selections.currentPriceDecimal,
    })
    .from(markets)
    .innerJoin(selections, eq(selections.marketId, markets.id))
    .where(
      and(
        inArray(markets.eventId, eventIds),
        eq(markets.status, "OPEN"),
        eq(selections.status, "OPEN"),
      ),
    );

  const byEvent = new Map<string, Map<string, MarketView>>();
  for (const row of marketRows) {
    let eventMarkets = byEvent.get(row.eventId);
    if (!eventMarkets) {
      eventMarkets = new Map();
      byEvent.set(row.eventId, eventMarkets);
    }
    let market = eventMarkets.get(row.marketId);
    if (!market) {
      market = { id: row.marketId, key: row.marketKey, selections: [] };
      eventMarkets.set(row.marketId, market);
    }
    market.selections.push({
      id: row.selectionId,
      key: row.selectionKey,
      label: row.label,
      line: row.line === null ? null : Number(row.line),
      price: Number(row.price),
    });
  }

  const grouped = new Map<string, HotShowcaseEvent[]>();
  for (const row of ranked) {
    const list = grouped.get(row.sport) ?? [];
    list.push({
      id: row.id,
      providerEventId: row.provider_event_id,
      sport: row.sport,
      league: row.league,
      home: row.home,
      away: row.away,
      startsAt: new Date(row.starts_at).toISOString(),
      status: row.status,
      homeScore: row.home_score === null ? null : Number(row.home_score),
      awayScore: row.away_score === null ? null : Number(row.away_score),
      markets: [...(byEvent.get(row.id)?.values() ?? [])],
    });
    grouped.set(row.sport, list);
  }

  const categories: SportHotCategory[] = [];
  for (const def of SPORTS_CATALOG) {
    const rawEvents = grouped.get(def.key);
    if (!rawEvents || rawEvents.length === 0) continue;

    // Prioritize LIVE, then priced, then marquee league, then soonest kickoff.
    const sorted = [...rawEvents].sort((a, b) => {
      const aLive = a.status === "LIVE" ? 0 : 1;
      const bLive = b.status === "LIVE" ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;

      const aPriced = a.markets.length > 0 ? 0 : 1;
      const bPriced = b.markets.length > 0 ? 0 : 1;
      if (aPriced !== bPriced) return aPriced - bPriced;

      const aPri = leaguePriority(def.key, a.league);
      const bPri = leaguePriority(def.key, b.league);
      if (aPri !== bPri) return aPri - bPri;

      return Date.parse(a.startsAt) - Date.parse(b.startsAt);
    });

    const summary = counts[def.key];
    categories.push({
      sport: def.key,
      label: def.label,
      shortLabel: def.shortLabel,
      twoWayDefault: def.twoWayDefault,
      liveCount: summary?.live ?? sorted.filter((e) => e.status === "LIVE").length,
      upcomingCount: summary?.upcoming ?? sorted.length,
      events: sorted,
    });
  }

  // Float sports with active LIVE matches to the front while preserving catalog order.
  categories.sort((a, b) => {
    const aHasLive = a.liveCount > 0 ? 0 : 1;
    const bHasLive = b.liveCount > 0 ? 0 : 1;
    if (aHasLive !== bHasLive) return aHasLive - bHasLive;
    return 0;
  });

  return categories;
}
