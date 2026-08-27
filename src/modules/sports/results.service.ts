import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Results, form and head-to-head.
 *
 * Everything here is a READ over fixtures that have already settled. Pooled
 * client, no locks, no money — this is the part of the product people use
 * without betting, and it must stay cheap enough that they can.
 *
 * It is also the data phase 18's analysis will reason over. Form and
 * head-to-head are exactly the inputs a prediction needs, and they only became
 * expressible once phase 6 gave teams stable identities — before that,
 * "Arsenal" and "Arsenal FC" were different clubs with separate histories.
 */

export interface ResultRow {
  eventId: string;
  playedAt: Date;
  competition: string | null;
  homeName: string;
  awayName: string;
  homeScore: number | null;
  awayScore: number | null;
  /** Half-time score when the provider supplied one. */
  halfTimeHome: number | null;
  halfTimeAway: number | null;
}

/*
 * The regulation score, read from `periods.ft`.
 *
 * The same source settlement uses, and for the same reason: a match decided on
 * penalties is a draw for betting purposes, and a top-level aggregate would
 * disagree with what the bets actually paid. A results page that contradicts
 * the settlement is a support ticket per fixture.
 *
 * `event_results` is append-only — a corrected score is a NEW row — so the
 * lateral join takes the newest rather than returning a fixture once per
 * ingestion.
 */
const LATEST_RESULT = sql`
  LEFT JOIN LATERAL (
    SELECT er.periods
    FROM event_results er
    WHERE er.event_id = e.id
    ORDER BY er.ingested_at DESC
    LIMIT 1
  ) r ON true
`;

const SCORE_COLUMNS = sql`
  (r.periods -> 'ft' ->> 'home')::int AS home_score,
  (r.periods -> 'ft' ->> 'away')::int AS away_score,
  (r.periods -> 'p1' ->> 'home')::int AS ht_home,
  (r.periods -> 'p1' ->> 'away')::int AS ht_away
`;

type ResultQueryRow = {
  event_id: string;
  starts_at: Date;
  competition: string | null;
  home: string;
  away: string;
  home_score: number | null;
  away_score: number | null;
  ht_home: number | null;
  ht_away: number | null;
};

function toResult(row: ResultQueryRow): ResultRow {
  return {
    eventId: row.event_id,
    playedAt: new Date(row.starts_at),
    competition: row.competition,
    homeName: row.home,
    awayName: row.away,
    homeScore: row.home_score === null ? null : Number(row.home_score),
    awayScore: row.away_score === null ? null : Number(row.away_score),
    halfTimeHome: row.ht_home === null ? null : Number(row.ht_home),
    halfTimeAway: row.ht_away === null ? null : Number(row.ht_away),
  };
}

/** Settled fixtures, newest first, optionally filtered. */
export async function recentResults(opts?: {
  competitionId?: string;
  teamId?: string;
  since?: Date;
  limit?: number;
}): Promise<ResultRow[]> {
  const limit = Math.min(opts?.limit ?? 50, 200);

  const rows = await db.execute<ResultQueryRow>(sql`
    SELECT e.id AS event_id, e.starts_at, c.name AS competition, e.home, e.away,
           ${SCORE_COLUMNS}
    FROM events e
    LEFT JOIN competitions c ON c.id = e.competition_id
    ${LATEST_RESULT}
    WHERE e.status = 'SETTLED'
      AND (${opts?.competitionId ?? null}::uuid IS NULL
           OR e.competition_id = ${opts?.competitionId ?? null}::uuid)
      AND (${opts?.teamId ?? null}::uuid IS NULL
           OR e.home_team_id = ${opts?.teamId ?? null}::uuid
           OR e.away_team_id = ${opts?.teamId ?? null}::uuid)
      AND (${opts?.since?.toISOString() ?? null}::timestamptz IS NULL
           OR e.starts_at >= ${opts?.since?.toISOString() ?? null}::timestamptz)
    ORDER BY e.starts_at DESC
    LIMIT ${limit}
  `);

  return rows.map(toResult);
}

export type FormLetter = "W" | "D" | "L";

export interface TeamForm {
  teamId: string;
  name: string;
  /** Most recent first. */
  form: FormLetter[];
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
}

/**
 * A team's recent form.
 *
 * Computed in SQL rather than by fetching results and folding them in
 * TypeScript: this is called once per team on a fixture page, and two round
 * trips per match is how a stats page becomes the slowest thing in the
 * product.
 *
 * The CASE expressions flip perspective by whether the team was home or away,
 * which is the whole subtlety — a 2-1 is a win for one side and a loss for the
 * other, from the same row.
 */
export async function teamForm(teamId: string, limit = 6): Promise<TeamForm | null> {
  const [team] = await db.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM teams WHERE id = ${teamId}::uuid
  `);
  if (!team) return null;

  const rows = await db.execute<{
    is_home: boolean;
    scored: number | null;
    conceded: number | null;
  }>(sql`
    SELECT (e.home_team_id = ${teamId}::uuid) AS is_home,
           CASE WHEN e.home_team_id = ${teamId}::uuid
                THEN (r.periods -> 'ft' ->> 'home')::int
                ELSE (r.periods -> 'ft' ->> 'away')::int END AS scored,
           CASE WHEN e.home_team_id = ${teamId}::uuid
                THEN (r.periods -> 'ft' ->> 'away')::int
                ELSE (r.periods -> 'ft' ->> 'home')::int END AS conceded
    FROM events e
    ${LATEST_RESULT}
    WHERE e.status = 'SETTLED'
      AND (e.home_team_id = ${teamId}::uuid OR e.away_team_id = ${teamId}::uuid)
      AND r.periods IS NOT NULL
    ORDER BY e.starts_at DESC
    LIMIT ${Math.min(limit, 20)}
  `);

  const form: FormLetter[] = [];
  let won = 0;
  let drawn = 0;
  let lost = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const row of rows) {
    // A settled fixture with no regulation score is unclassifiable, and
    // guessing would put a wrong letter in somebody's form guide.
    if (row.scored === null || row.conceded === null) continue;

    const scored = Number(row.scored);
    const conceded = Number(row.conceded);
    goalsFor += scored;
    goalsAgainst += conceded;

    if (scored > conceded) {
      form.push("W");
      won += 1;
    } else if (scored === conceded) {
      form.push("D");
      drawn += 1;
    } else {
      form.push("L");
      lost += 1;
    }
  }

  return {
    teamId: team.id,
    name: team.name,
    form,
    played: form.length,
    won,
    drawn,
    lost,
    goalsFor,
    goalsAgainst,
  };
}

export interface HeadToHeadSummary {
  meetings: ResultRow[];
  teamAWins: number;
  teamBWins: number;
  draws: number;
}

/**
 * Past meetings between two teams, from A's perspective.
 *
 * The perspective matters: "3 wins" is meaningless without saying whose. The
 * caller passes A and B, and the counts are labelled accordingly rather than
 * left as home/away totals that flip between fixtures.
 */
export async function headToHead(
  teamAId: string,
  teamBId: string,
  limit = 10,
): Promise<HeadToHeadSummary> {
  const rows = await db.execute<ResultQueryRow & { home_team_id: string }>(sql`
    SELECT e.id AS event_id, e.starts_at, c.name AS competition, e.home, e.away,
           e.home_team_id, ${SCORE_COLUMNS}
    FROM events e
    LEFT JOIN competitions c ON c.id = e.competition_id
    ${LATEST_RESULT}
    WHERE e.status = 'SETTLED'
      AND (
        (e.home_team_id = ${teamAId}::uuid AND e.away_team_id = ${teamBId}::uuid)
        OR (e.home_team_id = ${teamBId}::uuid AND e.away_team_id = ${teamAId}::uuid)
      )
    ORDER BY e.starts_at DESC
    LIMIT ${Math.min(limit, 50)}
  `);

  let teamAWins = 0;
  let teamBWins = 0;
  let draws = 0;

  for (const row of rows) {
    if (row.home_score === null || row.away_score === null) continue;

    const home = Number(row.home_score);
    const away = Number(row.away_score);
    if (home === away) {
      draws += 1;
      continue;
    }

    const homeWon = home > away;
    const homeIsTeamA = row.home_team_id === teamAId;
    if (homeWon === homeIsTeamA) teamAWins += 1;
    else teamBWins += 1;
  }

  return { meetings: rows.map(toResult), teamAWins, teamBWins, draws };
}
