import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Live odds and scores for the client.
 *
 * WHY THIS POLLS RATHER THAN PUSHES
 *
 * The obvious answer to "live" is WebSockets or SSE. On this deployment target
 * it is the wrong one, and the reason is worth writing down so nobody
 * "upgrades" it back.
 *
 * This app deploys to Vercel (see scripts/vercel-build.mjs). Every open SSE
 * stream or WebSocket occupies a serverless invocation for its whole life, so
 * a thousand people watching a match is a thousand concurrent invocations —
 * which hits the concurrency ceiling and bills for idle connections. The
 * platform is built for short requests, and holding one open fights it.
 *
 * A conditional poll is a much better fit for what an odds board actually
 * needs. Latency of a few seconds is imperceptible on a price that changes
 * every thirty; each poll is a short request that scales the way the platform
 * expects; and an unchanged board returns 304 with no body, so the steady
 * state costs almost nothing.
 *
 * WHAT MAKES IT CHEAP
 * A version cursor derived from the newest `updated_at` across the fixtures in
 * view. The client sends back what it last saw; if nothing has moved, it gets
 * 304 and no payload.
 *
 * WHEN TO REPLACE IT
 * The moment this runs somewhere that holds connections cheaply — a container,
 * a VPS, or a managed realtime service — `LiveFeed` is the seam to swap. The
 * shape below (a snapshot plus a cursor) is deliberately the same shape a push
 * transport would deliver, so nothing above it changes.
 */

export interface LiveSelection {
  id: string;
  key: string;
  label: string;
  price: number;
  suspended: boolean;
}

export interface LiveMarket {
  id: string;
  key: string;
  suspended: boolean;
  selections: LiveSelection[];
}

export interface LiveEvent {
  id: string;
  fixture: string;
  startsAt: string;
  status: string;
  /** Regulation score when a result has been ingested. */
  homeScore: number | null;
  awayScore: number | null;
  markets: LiveMarket[];
}

export interface LiveSnapshot {
  /** Opaque cursor. Hand it back to find out whether anything changed. */
  version: string;
  events: LiveEvent[];
}

/**
 * The cursor.
 *
 * Built from the newest `updated_at` across the fixtures in view plus a row
 * count. The timestamp alone is not enough: a market being suspended and
 * another appearing in the same millisecond would leave the cursor unchanged
 * while the board differs. The count catches that at negligible cost.
 */
export async function liveVersion(sportKey: string): Promise<string> {
  const [row] = await db.execute<{ newest: string | null; n: number }>(sql`
    SELECT
      to_char(max(GREATEST(e.updated_at, m.updated_at, s.updated_at)),
              'YYYYMMDDHH24MISSUS') AS newest,
      count(*)::int AS n
    FROM events e
    JOIN markets m ON m.event_id = e.id
    JOIN selections s ON s.market_id = m.id
    WHERE e.sport = ${sportKey}
      AND e.status IN ('PENDING', 'LIVE')
      AND e.starts_at > now() - INTERVAL '4 hours'
  `);

  return `${row?.newest ?? "0"}-${row?.n ?? 0}`;
}

/**
 * Everything currently in play or about to be.
 *
 * The four-hour trailing window keeps a match that has kicked off in view
 * without dragging in yesterday's fixtures — a live board that quietly grows
 * all season is how a cheap query becomes an expensive one.
 */
export async function liveSnapshot(sportKey: string, limit = 50): Promise<LiveSnapshot> {
  const rows = await db.execute<{
    event_id: string;
    home: string;
    away: string;
    starts_at: Date;
    event_status: string;
    home_score: number | null;
    away_score: number | null;
    market_id: string;
    market_key: string;
    market_status: string;
    selection_id: string;
    selection_key: string;
    label: string;
    price: string;
    selection_status: string;
  }>(sql`
    SELECT e.id AS event_id, e.home, e.away, e.starts_at,
           e.status::text AS event_status,
           (r.periods -> 'ft' ->> 'home')::int AS home_score,
           (r.periods -> 'ft' ->> 'away')::int AS away_score,
           m.id AS market_id, m.key AS market_key, m.status::text AS market_status,
           s.id AS selection_id, s.key AS selection_key, s.label,
           s.current_price_decimal::text AS price, s.status::text AS selection_status
    FROM events e
    JOIN markets m ON m.event_id = e.id
    JOIN selections s ON s.market_id = m.id
    -- Append-only results: take the newest, or a corrected score would appear
    -- alongside the original rather than replacing it.
    LEFT JOIN LATERAL (
      SELECT er.periods FROM event_results er
      WHERE er.event_id = e.id ORDER BY er.ingested_at DESC LIMIT 1
    ) r ON true
    WHERE e.sport = ${sportKey}
      AND e.status IN ('PENDING', 'LIVE')
      AND e.starts_at > now() - INTERVAL '4 hours'
    ORDER BY e.starts_at, e.id, m.key, s.key
    LIMIT ${limit * 24}
  `);

  const byEvent = new Map<string, LiveEvent>();

  for (const row of rows) {
    let event = byEvent.get(row.event_id);
    if (!event) {
      if (byEvent.size >= limit) continue;
      event = {
        id: row.event_id,
        fixture: `${row.home} v ${row.away}`,
        startsAt: new Date(row.starts_at).toISOString(),
        status: row.event_status,
        homeScore: row.home_score === null ? null : Number(row.home_score),
        awayScore: row.away_score === null ? null : Number(row.away_score),
        markets: [],
      };
      byEvent.set(row.event_id, event);
    }

    let market = event.markets.find((candidate) => candidate.id === row.market_id);
    if (!market) {
      market = {
        id: row.market_id,
        key: row.market_key,
        suspended: row.market_status !== "OPEN",
        selections: [],
      };
      event.markets.push(market);
    }

    market.selections.push({
      id: row.selection_id,
      key: row.selection_key,
      label: row.label,
      price: Number(row.price),
      // A selection is unbettable if EITHER it or its market is closed. The
      // client must not offer a price the placement path would refuse.
      suspended: market.suspended || row.selection_status !== "OPEN",
    });
  }

  return {
    version: await liveVersion(sportKey),
    events: [...byEvent.values()],
  };
}

/**
 * Suspends every market on an event.
 *
 * Called when something happens that invalidates the current prices — a goal,
 * a red card, a penalty. Prices are stale from the instant of the incident
 * until the feed reprices, and a market left open in that window is a market
 * where somebody who saw the incident first can bet on a known outcome.
 *
 * Suspending is cheap and reversible; being late is neither.
 */
export async function suspendEventMarkets(eventId: string, reason: string): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE markets
    SET status = 'SUSPENDED', updated_at = now()
    WHERE event_id = ${eventId}::uuid AND status = 'OPEN'
    RETURNING id
  `);

  if (rows.length > 0) {
    console.info(`[live] suspended ${rows.length} markets on ${eventId}: ${reason}`);
  }
  return rows.length;
}
