import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db/pooled";
import { events, markets, oddsSnapshots, selections } from "./schema";
import type { OddsSnapshot } from "./provider";

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
        inArray(events.status, ["PENDING", "LIVE"]),
        gte(events.startsAt, new Date()),
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
