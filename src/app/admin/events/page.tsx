import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { guardAdminPage } from "../_guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Events" };

/**
 * The sportsbook board, and whether the feed behind it is alive.
 *
 * The stalled column is the reason this page exists. When the odds provider
 * changes its response shape, ingestion correctly refuses to record results —
 * but refusing throws nothing, so bets simply stay PENDING while customers
 * wait to be paid. That is invisible everywhere except here and the
 * Settlement alert on the dashboard.
 */

type EventRow = {
  id: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  starts_at: Date;
  status: string;
  market_count: number;
  selection_count: number;
  pending_bets: number;
  has_result: boolean;
  finished: boolean;
  newest_price: Date | null;
}

const STATUS_PILL: Record<string, string> = {
  PENDING: "pill",
  LIVE: "pill ok",
  SETTLED: "pill ok",
  CANCELLED: "pill warning",
};

export default async function AdminEventsPage() {
  const guard = await guardAdminPage("sportsbook.read", "Events");
  if (!guard.ok) return guard.denied;

  const rows = await db.execute<EventRow>(sql`
    SELECT
      e.id::text, e.sport, e.league, e.home, e.away, e.starts_at, e.status::text,
      count(DISTINCT m.id)::int AS market_count,
      count(DISTINCT s.id)::int AS selection_count,
      count(DISTINCT b.id) FILTER (WHERE b.status = 'PENDING')::int AS pending_bets,
      EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = e.id) AS has_result,
      -- Staleness is judged by the clock that WROTE these timestamps.
      -- Comparing a database timestamp against the web server's own clock
      -- makes the stalled column disagree with the stalled count above the
      -- moment the two machines drift, and the count already asks Postgres.
      (e.starts_at < now() - INTERVAL '6 hours') AS finished,
      max(s.updated_at) AS newest_price
    FROM events e
    LEFT JOIN markets m ON m.event_id = e.id
    LEFT JOIN selections s ON s.market_id = m.id
    LEFT JOIN bet_legs l ON l.selection_id = s.id
    LEFT JOIN bets b ON b.id = l.bet_id
    GROUP BY e.id
    ORDER BY e.starts_at DESC
    LIMIT 150
  `);

  const [totals] = await db.execute<{
    total: number;
    live: number;
    pending: number;
    stalled: number;
  }>(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'LIVE')::int AS live,
      count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      -- Finished long ago, no result recorded, and money riding on it.
      count(*) FILTER (
        WHERE status IN ('PENDING','LIVE')
          AND starts_at < now() - INTERVAL '6 hours'
          AND NOT EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = events.id)
      )::int AS stalled
    FROM events
  `);

  const [feed] = await db.execute<{ newest: Date | null; stale_minutes: number | null }>(sql`
    SELECT
      max(updated_at) AS newest,
      -- Same reasoning as the stalled column: the age of a database row is a
      -- question for the database, not for this process's clock.
      floor(EXTRACT(EPOCH FROM (now() - max(updated_at))) / 60)::int AS stale_minutes
    FROM selections
  `);

  const staleMinutes = feed?.newest ? Number(feed.stale_minutes ?? 0) : null;

  return (
    <>
      <header className="page-head">
        <h1>Events</h1>
        <p className="muted">
          {totals?.total ?? 0} events · {totals?.live ?? 0} live · {totals?.pending ?? 0} upcoming
        </p>
      </header>

      {Number(totals?.stalled ?? 0) > 0 ? (
        <p className="notice error">
          <strong>{totals!.stalled} finished events have no result.</strong> Settlement is
          stalled — check the provider response shape. Customers with pending bets on these
          cannot be paid.
        </p>
      ) : null}

      {staleMinutes !== null && staleMinutes > 60 ? (
        <p className="notice error">
          No price has moved in {staleMinutes} minutes. The odds feed is not running.
        </p>
      ) : staleMinutes === null ? (
        <p className="notice">
          No prices have ever been synced. The odds worker has not run — the board is empty.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="notice">
          No events. Run the odds sync worker to populate the board.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="statement">
            <thead>
              <tr>
                <th>Kick-off</th>
                <th>Match</th>
                <th>Competition</th>
                <th className="right">Markets</th>
                <th className="right">Open bets</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => {
                const stalled =
                  event.finished && !event.has_result && event.status !== "CANCELLED";
                return (
                  <tr key={event.id}>
                    <td className="muted">{new Date(event.starts_at).toLocaleString()}</td>
                    <td>
                      {event.home} v {event.away}
                    </td>
                    <td className="muted">{event.league}</td>
                    <td className="right muted">
                      {event.market_count} / {event.selection_count}
                    </td>
                    <td className="right">{event.pending_bets || "—"}</td>
                    <td>
                      <span className={STATUS_PILL[event.status] ?? "pill"}>
                        {event.status.toLowerCase()}
                      </span>
                      {stalled ? <span className="pill critical"> no result</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
