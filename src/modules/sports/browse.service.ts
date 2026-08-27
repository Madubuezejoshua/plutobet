import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Reading the sports hierarchy for navigation.
 *
 * Pooled client and no locks: this is browsing, the hottest read in the
 * product, and it never participates in a money movement.
 *
 * Everything here counts only fixtures that are actually BETTABLE — upcoming
 * or live, with at least one open market. A competition listed in the
 * navigation that opens onto an empty board is a worse experience than one
 * that is not listed at all, and a count that includes unbettable fixtures is
 * a promise the board cannot keep.
 */

export interface SportSummary {
  key: string;
  name: string;
  active: boolean;
  fixtureCount: number;
}

export interface CompetitionSummary {
  id: string;
  key: string;
  name: string;
  country: string | null;
  fixtureCount: number;
}

/** Sports with something to bet on, in curated display order. */
export async function listSports(): Promise<SportSummary[]> {
  const rows = await db.execute<{
    key: string;
    name: string;
    active: boolean;
    fixture_count: number;
  }>(sql`
    SELECT s.key, s.name, s.active,
           count(DISTINCT e.id)::int AS fixture_count
    FROM sports s
    LEFT JOIN events e
      ON e.sport_id = s.id
     AND e.status IN ('PENDING', 'LIVE')
     AND e.starts_at >= now()
     AND EXISTS (
       SELECT 1 FROM markets m WHERE m.event_id = e.id AND m.status = 'OPEN'
     )
    WHERE s.active = true
    GROUP BY s.key, s.name, s.active, s.display_order
    ORDER BY s.display_order, s.name
  `);

  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    active: row.active,
    fixtureCount: Number(row.fixture_count),
  }));
}

/**
 * Competitions within a sport that currently have fixtures.
 *
 * Ordered by fixture count rather than alphabetically: the competition with
 * forty matches this weekend is the one people came for, and an alphabetical
 * list buries it under whatever begins with "A".
 */
export async function listCompetitions(sportKey: string): Promise<CompetitionSummary[]> {
  const rows = await db.execute<{
    id: string;
    key: string;
    name: string;
    country: string | null;
    fixture_count: number;
  }>(sql`
    SELECT c.id, c.key, c.name, c.country, count(e.id)::int AS fixture_count
    FROM competitions c
    JOIN sports s ON s.id = c.sport_id AND s.key = ${sportKey}
    JOIN events e
      ON e.competition_id = c.id
     AND e.status IN ('PENDING', 'LIVE')
     AND e.starts_at >= now()
    WHERE EXISTS (
      SELECT 1 FROM markets m WHERE m.event_id = e.id AND m.status = 'OPEN'
    )
    GROUP BY c.id, c.key, c.name, c.country
    ORDER BY fixture_count DESC, c.name
    LIMIT 60
  `);

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    country: row.country,
    fixtureCount: Number(row.fixture_count),
  }));
}

export interface HeadToHead {
  playedAt: Date;
  competition: string | null;
  homeName: string;
  awayName: string;
  homeScore: number | null;
  awayScore: number | null;
}

/**
 * Past meetings between two teams.
 *
 * This is the first read that would have been impossible before this phase:
 * with team names as free text, "Arsenal" and "Arsenal FC" were different
 * clubs and their shared history was split between them.
 *
 * It is also the shape phase 18's analysis will want, which is why the
 * hierarchy needed to land before the AI work rather than after.
 */
export async function headToHead(
  teamAId: string,
  teamBId: string,
  limit = 10,
): Promise<HeadToHead[]> {
  const rows = await db.execute<{
    starts_at: Date;
    competition: string | null;
    home_name: string;
    away_name: string;
    home_score: number | null;
    away_score: number | null;
  }>(sql`
    SELECT e.starts_at, c.name AS competition,
           home.name AS home_name, away.name AS away_name,
           (r.periods -> 'ft' ->> 'home')::int AS home_score,
           (r.periods -> 'ft' ->> 'away')::int AS away_score
    FROM events e
    JOIN teams home ON home.id = e.home_team_id
    JOIN teams away ON away.id = e.away_team_id
    LEFT JOIN competitions c ON c.id = e.competition_id
    /*
     * event_results is append-only -- a corrected result is a NEW row, not an
     * edit -- so this takes the most recently ingested one. Joining the table
     * directly would return a match once per ingestion and double-count a
     * corrected fixture.
     *
     * The score is read from periods.ft, the regulation score, for the same
     * reason settlement does: a match decided on penalties is a draw for
     * betting purposes, and the top-level aggregate would say otherwise.
     */
    LEFT JOIN LATERAL (
      SELECT er.periods
      FROM event_results er
      WHERE er.event_id = e.id
      ORDER BY er.ingested_at DESC
      LIMIT 1
    ) r ON true
    WHERE e.status = 'SETTLED'
      AND (
        (e.home_team_id = ${teamAId}::uuid AND e.away_team_id = ${teamBId}::uuid)
        OR (e.home_team_id = ${teamBId}::uuid AND e.away_team_id = ${teamAId}::uuid)
      )
    ORDER BY e.starts_at DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    playedAt: new Date(row.starts_at),
    competition: row.competition,
    homeName: row.home_name,
    awayName: row.away_name,
    homeScore: row.home_score === null ? null : Number(row.home_score),
    awayScore: row.away_score === null ? null : Number(row.away_score),
  }));
}
