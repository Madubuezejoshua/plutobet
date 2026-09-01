import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeWalletTestContexts,
  createWalletTestContext,
  type WalletTestContext,
} from "@/modules/wallet/__tests__/helpers";
import { WalletService } from "@/modules/wallet/wallet.service";
import { BatchClassifier, CLASSIFY_CHUNK, type FixtureToClassify } from "../classify-batch";
import { normalizeTeamKey } from "../canonical-name";

/**
 * Batch classification: correctness and SHAPE, never wall-clock.
 *
 * These tests assert what the batch guarantees — idempotency, no duplicates,
 * bounded statements, isolation of bad rows — and deliberately assert no
 * timing at all. A millisecond threshold measured here would fail on a slower
 * shared CI machine while proving nothing about the algorithm. Runtime belongs
 * in `scripts/bench-sync-fixtures.ts`, which is reproducible and reports
 * numbers rather than passing or failing.
 *
 * The property that actually matters for speed is asserted structurally: the
 * statement count must stay flat as the event count grows. That is the whole
 * claim, and it holds on any hardware.
 *
 * TEST DATA ENCODING: the suite's embedded PostgreSQL runs a WIN1252 client
 * encoding on Windows, so characters outside it (Cyrillic, Greek, Turkish ş)
 * cannot be sent and the row is rejected — an environment limit, not a product
 * one; production Neon is UTF8 and round-trips them, verified directly. Where a
 * wholly non-Latin name is needed, the key is asserted at the pure-function
 * level, and storage is proven with a WIN1252-safe name that still drives the
 * same empty-key fallback path.
 */

const ctx: WalletTestContext = createWalletTestContext();
const classifier = new BatchClassifier(new WalletService(ctx.database));

afterAll(async () => {
  await closeWalletTestContexts([ctx]);
});

async function seedEvents(provider: string, fixtures: {
  eventId: string;
  league: string;
  home: string;
  away: string;
  status?: string;
}[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const fixture of fixtures) {
    const [row] = await ctx.database.execute<{ id: string }>(sql`
      INSERT INTO events (provider, provider_event_id, sport, league, home, away, starts_at, status)
      VALUES (
        ${provider}, ${fixture.eventId}, 'football', ${fixture.league},
        ${fixture.home}, ${fixture.away}, now() + interval '2 days',
        ${fixture.status ?? "PENDING"}
      )
      ON CONFLICT (provider, provider_event_id) DO UPDATE SET league = excluded.league
      RETURNING id
    `);
    ids.set(fixture.eventId, row!.id);
  }
  return ids;
}

function fixtureSet(provider: string, count: number): {
  eventId: string;
  league: string;
  home: string;
  away: string;
}[] {
  // Names repeat on purpose: a real feed is a league week, twenty fixtures over
  // the same forty clubs. Repetition is exactly what the batch must collapse.
  const leagues = [
    `${provider} Country - Premier League`,
    `${provider} Country - Segunda`,
    `${provider} Otherland - Bundesliga`,
  ];
  const clubs = [
    `${provider} Arsenal`,
    `${provider} CD O´Higgins`,
    `${provider} Bayern München`,
    `${provider} Atlético Madrid`,
    `${provider} Chelsea`,
    `${provider} Real Betis`,
  ];
  return Array.from({ length: count }, (_, i) => ({
    eventId: `${provider}-evt-${i}`,
    league: leagues[i % leagues.length]!,
    home: clubs[i % clubs.length]!,
    away: clubs[(i + 2) % clubs.length]!,
  }));
}

function toInputs(
  ids: Map<string, string>,
  fixtures: { eventId: string; league: string; home: string; away: string }[],
): FixtureToClassify[] {
  return fixtures.map((f) => ({
    eventId: ids.get(f.eventId)!,
    sport: "football",
    league: f.league,
    home: f.home,
    away: f.away,
  }));
}

async function classifiedCount(provider: string): Promise<number> {
  const [row] = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM events
    WHERE provider = ${provider} AND competition_id IS NOT NULL
      AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
  `);
  return Number(row?.n ?? 0);
}

describe("batch classification", () => {
  it("keeps the statement count FLAT as the event count grows", async () => {
    const small = `flatA-${randomUUID().slice(0, 8)}`;
    const large = `flatB-${randomUUID().slice(0, 8)}`;

    const smallFixtures = fixtureSet(small, 10);
    const largeFixtures = fixtureSet(large, CLASSIFY_CHUNK);

    const smallResult = await classifier.classify(
      toInputs(await seedEvents(small, smallFixtures), smallFixtures),
    );
    const largeResult = await classifier.classify(
      toInputs(await seedEvents(large, largeFixtures), largeFixtures),
    );

    /*
     * This is the performance claim, stated as an invariant instead of a
     * stopwatch. Ten events and a hundred events must cost the SAME number of
     * statements and the same single transaction; the old code cost about
     * nineteen round trips per event, so it would fail here by an order of
     * magnitude on the larger set.
     */
    expect(smallResult.transactions).toBe(1);
    expect(largeResult.transactions).toBe(1);
    expect(largeResult.statements).toBe(smallResult.statements);
    expect(largeResult.statements).toBeLessThanOrEqual(8);
    expect(largeResult.classified).toBe(CLASSIFY_CHUNK);
  });

  it("uses one transaction per chunk, not per event", async () => {
    const provider = `chunks-${randomUUID().slice(0, 8)}`;
    const fixtures = fixtureSet(provider, CLASSIFY_CHUNK * 2 + 5);
    const result = await classifier.classify(
      toInputs(await seedEvents(provider, fixtures), fixtures),
    );

    // 205 events over a 100-event chunk is three transactions. Per-event would
    // be 205, which is the shape this replaced.
    expect(result.transactions).toBe(3);
    expect(result.classified).toBe(fixtures.length);
  });

  it("is idempotent — re-running the same batch creates no duplicates", async () => {
    const provider = `idem-${randomUUID().slice(0, 8)}`;
    const fixtures = fixtureSet(provider, 60);
    const ids = await seedEvents(provider, fixtures);
    const inputs = toInputs(ids, fixtures);

    await classifier.classify(inputs);
    const [afterFirst] = await ctx.database.execute<{ teams: number; comps: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM teams WHERE name LIKE ${provider + "%"}) AS teams,
        (SELECT count(*)::int FROM competitions WHERE name LIKE ${provider + "%"}) AS comps
    `);

    await classifier.classify(inputs);
    await classifier.classify(inputs);
    const [afterThird] = await ctx.database.execute<{ teams: number; comps: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM teams WHERE name LIKE ${provider + "%"}) AS teams,
        (SELECT count(*)::int FROM competitions WHERE name LIKE ${provider + "%"}) AS comps
    `);

    expect(Number(afterThird!.teams)).toBe(Number(afterFirst!.teams));
    expect(Number(afterThird!.comps)).toBe(Number(afterFirst!.comps));
    expect(await classifiedCount(provider)).toBe(60);
  });

  it("creates no duplicates when two syncs run simultaneously", async () => {
    const provider = `race-${randomUUID().slice(0, 8)}`;
    const fixtures = fixtureSet(provider, 40);
    const inputs = toInputs(await seedEvents(provider, fixtures), fixtures);

    // Two INDEPENDENT connections, so this is a real database race rather than
    // two calls queued on one client. `INSERT .. ON CONFLICT DO NOTHING` then
    // `SELECT` is what makes the loser read the winner's row; batching widens
    // that window, so this matters more here than in the per-event path.
    const other = createWalletTestContext();
    try {
      const rival = new BatchClassifier(new WalletService(other.database));
      const [a, b] = await Promise.all([
        classifier.classify(inputs),
        rival.classify(inputs),
      ]);
      expect(a.classified).toBe(40);
      expect(b.classified).toBe(40);
    } finally {
      await closeWalletTestContexts([other]);
    }

    const [dupes] = await ctx.database.execute<{ teams: number; comps: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM (
          SELECT sport_id, key FROM teams WHERE name LIKE ${provider + "%"}
          GROUP BY sport_id, key HAVING count(*) > 1
        ) d) AS teams,
        (SELECT count(*)::int FROM (
          SELECT sport_id, key FROM competitions WHERE name LIKE ${provider + "%"}
          GROUP BY sport_id, key HAVING count(*) > 1
        ) d) AS comps
    `);
    expect(Number(dupes!.teams)).toBe(0);
    expect(Number(dupes!.comps)).toBe(0);
  });

  it("stores non-ASCII names with constraint-valid keys", async () => {
    const provider = `nonascii-${randomUUID().slice(0, 8)}`;
    const fixtures = fixtureSet(provider, 12);
    await classifier.classify(toInputs(await seedEvents(provider, fixtures), fixtures));

    const rows = await ctx.database.execute<{ key: string; name: string }>(sql`
      SELECT key, name FROM teams WHERE name LIKE ${provider + "%"}
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // teams_key_format. A violation here is the bug that silently unlisted
      // every club with an acute accent in its name.
      expect(row.key).toMatch(/^[a-z0-9-]{1,120}$/);
    }
    // The display name keeps its accents; only the KEY is reduced.
    expect(rows.some((r) => r.name.includes("ü") || r.name.includes("é"))).toBe(true);
  });

  it("gives a wholly non-Latin name a stable, collision-safe key", async () => {
    // Pure-function level, because the names that force this path cannot be
    // sent to a WIN1252 client (see the file header).
    const cyrillic = normalizeTeamKey("ЦСКА");
    const greek = normalizeTeamKey("ΠΑΟΚ");

    expect(cyrillic).toMatch(/^[a-z0-9-]{1,120}$/);
    expect(greek).toMatch(/^[a-z0-9-]{1,120}$/);
    expect(cyrillic).not.toBe(greek);
    // Stable: the same club must resolve to the same key on every sync, or a
    // new team row would appear every half hour.
    expect(normalizeTeamKey("ЦСКА")).toBe(cyrillic);

    // And the fallback survives a real round trip, using a WIN1252-safe name
    // that also cleans to nothing.
    const provider = `fallback-${randomUUID().slice(0, 8)}`;
    const fixtures = [
      { eventId: `${provider}-0`, league: `${provider} Country - Cup`, home: "«»", away: `${provider} Chelsea` },
    ];
    const result = await classifier.classify(
      toInputs(await seedEvents(provider, fixtures), fixtures),
    );
    expect(result.classified).toBe(1);
    const [row] = await ctx.database.execute<{ key: string }>(sql`
      SELECT t.key FROM teams t
      JOIN events e ON e.home_team_id = t.id
      WHERE e.provider = ${provider}
    `);
    expect(row!.key).toMatch(/^team-[0-9a-f]{16}$/);
  });

  it("reports a malformed fixture without corrupting the batch", async () => {
    const provider = `malformed-${randomUUID().slice(0, 8)}`;
    const good = fixtureSet(provider, 9);
    /*
     * A fixture with no team name at all.
     *
     * This originally asserted "normalises to nothing", which was WRONG:
     * `normalizeTeamKey("")` returns the deterministic hash fallback, so the
     * empty name became `team-e3b0c442...` — a real key, shared by every
     * nameless fixture ever ingested. The test caught a silent merge, not a
     * missing key. The classifier now refuses a blank name before hashing it;
     * the other nine must still classify.
     */
    const bad = { eventId: `${provider}-bad`, league: `${provider} Country - Cup`, home: "", away: "" };
    const fixtures = [...good, bad];
    const result = await classifier.classify(
      toInputs(await seedEvents(provider, fixtures), fixtures),
    );

    expect(result.classified).toBe(9);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.reason).toMatch(/no team name/);
    expect(await classifiedCount(provider)).toBe(9);
  });

  it("does not violate the self-fixture constraint when both names share a key", async () => {
    const provider = `mirror-${randomUUID().slice(0, 8)}`;
    // Two spellings, one key. Writing both ids would breach
    // `events_teams_distinct` and take the whole chunk's UPDATE with it.
    const fixtures = [
      { eventId: `${provider}-0`, league: `${provider} Country - Cup`, home: `${provider} Arsenal F.C.`, away: `${provider} Arsenal` },
      ...fixtureSet(provider, 5),
    ];
    const result = await classifier.classify(
      toInputs(await seedEvents(provider, fixtures), fixtures),
    );

    expect(result.failures.some((f) => f.reason.includes("both normalise to"))).toBe(true);
    // The other five still land, and the offender keeps its competition.
    expect(await classifiedCount(provider)).toBe(5);
    const [row] = await ctx.database.execute<{ competition_id: string | null }>(sql`
      SELECT competition_id FROM events WHERE provider_event_id = ${`${provider}-0`}
    `);
    expect(row!.competition_id).not.toBeNull();
  });

  it("rolls the chunk back when the database rejects the write", async () => {
    const provider = `rollback-${randomUUID().slice(0, 8)}`;
    const fixtures = fixtureSet(provider, 6);
    const ids = await seedEvents(provider, fixtures);
    const inputs = toInputs(ids, fixtures);
    // A non-existent event id. The UPDATE ... FROM (VALUES) matches nothing for
    // it, but the cast is valid, so the interesting failure is a genuine
    // constraint breach: point one row at a malformed uuid instead.
    const corrupted: FixtureToClassify[] = [
      ...inputs,
      { eventId: "not-a-uuid", sport: "football", league: `${provider} Country - Cup`, home: `${provider} X`, away: `${provider} Y` },
    ];

    await expect(classifier.classify(corrupted)).rejects.toThrow();

    // Nothing from the failed chunk is visible: the teams it would have created
    // are absent, because the whole transaction rolled back.
    const [row] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM teams WHERE name LIKE ${provider + "%"}
    `);
    expect(Number(row!.n)).toBe(0);
    expect(await classifiedCount(provider)).toBe(0);
  });

  it("leaves an unknown sport unclassified rather than inventing one", async () => {
    const provider = `unknownsport-${randomUUID().slice(0, 8)}`;
    const fixtures = [
      { eventId: `${provider}-0`, league: `${provider} Country - League`, home: `${provider} A`, away: `${provider} B` },
    ];
    const ids = await seedEvents(provider, fixtures);
    const result = await classifier.classify([
      {
        eventId: ids.get(`${provider}-0`)!,
        sport: "underwater-basket-weaving",
        league: fixtures[0]!.league,
        home: fixtures[0]!.home,
        away: fixtures[0]!.away,
      },
    ]);

    expect(result.unresolvedSport).toBe(1);
    expect(result.classified).toBe(0);
    const [row] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM sports WHERE key = 'underwater-basket-weaving'
    `);
    expect(Number(row!.n)).toBe(0);
  });

  it("does not re-classify a settled fixture into a different shape", async () => {
    const provider = `settled-${randomUUID().slice(0, 8)}`;
    const fixtures = fixtureSet(provider, 4);
    const ids = await seedEvents(provider, fixtures);
    const inputs = toInputs(ids, fixtures);
    await classifier.classify(inputs);

    await ctx.database.execute(sql`
      UPDATE events SET status = 'SETTLED' WHERE provider = ${provider}
    `);
    const before = await ctx.database.execute<{
      id: string; competition_id: string; home_team_id: string; status: string;
    }>(sql`
      SELECT id, competition_id, home_team_id, status FROM events
      WHERE provider = ${provider} ORDER BY provider_event_id
    `);

    // Re-running classification must not disturb a settled fixture's identity
    // or its status — settlement reads these rows.
    await classifier.classify(inputs);
    const after = await ctx.database.execute<{
      id: string; competition_id: string; home_team_id: string; status: string;
    }>(sql`
      SELECT id, competition_id, home_team_id, status FROM events
      WHERE provider = ${provider} ORDER BY provider_event_id
    `);

    expect(after.map((r) => r.status)).toEqual(before.map(() => "SETTLED"));
    expect(after.map((r) => r.competition_id)).toEqual(before.map((r) => r.competition_id));
    expect(after.map((r) => r.home_team_id)).toEqual(before.map((r) => r.home_team_id));
  });

  it("never erases an existing classification when a later resolve returns null", async () => {
    const provider = `coalesce-${randomUUID().slice(0, 8)}`;
    const fixtures = fixtureSet(provider, 3);
    const ids = await seedEvents(provider, fixtures);
    await classifier.classify(toInputs(ids, fixtures));

    const [before] = await ctx.database.execute<{ competition_id: string }>(sql`
      SELECT competition_id FROM events WHERE provider_event_id = ${`${provider}-evt-0`}
    `);
    expect(before!.competition_id).not.toBeNull();

    // A label the parser cannot turn into the same competition. COALESCE must
    // keep the earlier, correct classification rather than nulling it — losing
    // data over a provider hiccup is worse than a stale label.
    await classifier.classify([
      {
        eventId: ids.get(`${provider}-evt-0`)!,
        sport: "football",
        league: `${provider} Country - Premier League`,
        home: fixtures[0]!.home,
        away: fixtures[0]!.away,
      },
    ]);
    const [after] = await ctx.database.execute<{ competition_id: string }>(sql`
      SELECT competition_id FROM events WHERE provider_event_id = ${`${provider}-evt-0`}
    `);
    expect(after!.competition_id).toBe(before!.competition_id);
  });

  it("prefers a recorded alias over a computed key", async () => {
    const provider = `alias-${randomUUID().slice(0, 8)}`;
    const [sport] = await ctx.database.execute<{ id: string }>(sql`
      SELECT id FROM sports WHERE key = 'football'
    `);
    const canonicalName = `${provider} Tottenham Hotspur`;
    const [team] = await ctx.database.execute<{ id: string }>(sql`
      INSERT INTO teams (sport_id, key, name)
      VALUES (${sport!.id}::uuid, ${normalizeTeamKey(canonicalName)}, ${canonicalName})
      RETURNING id
    `);
    const nickname = `${provider} Spurs`;
    await ctx.database.execute(sql`
      INSERT INTO team_aliases (team_id, sport_id, alias_key, source)
      VALUES (${team!.id}::uuid, ${sport!.id}::uuid, ${normalizeTeamKey(nickname)}, 'test')
    `);

    const fixtures = [
      { eventId: `${provider}-0`, league: `${provider} Country - Cup`, home: nickname, away: `${provider} Chelsea` },
    ];
    await classifier.classify(toInputs(await seedEvents(provider, fixtures), fixtures));

    const [row] = await ctx.database.execute<{ home_team_id: string }>(sql`
      SELECT home_team_id FROM events WHERE provider_event_id = ${`${provider}-0`}
    `);
    // The alias wins, and no second team was created for the nickname.
    expect(row!.home_team_id).toBe(team!.id);
    const [created] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM teams WHERE key = ${normalizeTeamKey(nickname)}
    `);
    expect(Number(created!.n)).toBe(0);
  });

  it("does nothing, and costs nothing, for an empty batch", async () => {
    const result = await classifier.classify([]);
    expect(result).toEqual({
      classified: 0,
      unresolvedSport: 0,
      failures: [],
      transactions: 0,
      statements: 0,
    });
  });
});
