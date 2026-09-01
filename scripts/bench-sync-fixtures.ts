/**
 * Reproducible benchmark for syncFixtures.
 *
 *   npx tsx scripts/bench-sync-fixtures.ts [eventCount]
 *
 * Uses a FIXED, generated dataset served by a stub provider — no live-provider
 * quota is spent, and the same input can be replayed before and after a
 * change. Measuring against the live feed would be neither reproducible nor
 * free.
 *
 * Reports runtime, entity counts, duplicates and failures. It writes to the
 * configured database, so point it at a scratch one.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { OddsSyncService } from "@/modules/odds/sync.service";
import type { EventResult, OddsProvider, OddsSnapshot, SportEvent } from "@/modules/odds/provider";

const COUNT = Number(process.argv[2] ?? 775);
const PROVIDER = `bench-${Date.now()}`;

/**
 * A deterministic catalogue.
 *
 * Team and league names repeat across events on purpose: real feeds do, and
 * repeated taxonomy lookups are exactly the cost this benchmark is meant to
 * expose. Names include non-ASCII forms so the benchmark also exercises the
 * key-normalisation path.
 */
function dataset(count: number): SportEvent[] {
  const leagues = [
    "England - Premier League",
    "España - LaLiga",
    "España - Segunda",
    "Brazil - Série A",
    "Deutschland - Bundesliga",
  ];
  const clubs = [
    "Arsenal", "Chelsea", "CD O´Higgins", "Bayern München", "Atlético Madrid",
    "Atlético Madrid", "Grêmio", "Grêmio", "Borussia Mönchengladbach", "Real Betis",
  ];

  return Array.from({ length: count }, (_, i) => ({
    eventId: `${PROVIDER}-evt-${i}`,
    sport: "football",
    league: leagues[i % leagues.length]!,
    home: clubs[i % clubs.length]!,
    away: clubs[(i + 3) % clubs.length]!,
    startsAt: new Date(Date.now() + (i % 300) * 60 * 60_000),
    status: "PENDING" as const,
  }));
}

function stubProvider(events: SportEvent[]): OddsProvider {
  return {
    name: PROVIDER,
    async listEvents() {
      return events;
    },
    async listLiveEvents() {
      return [] as SportEvent[];
    },
    async getOdds() {
      return [] as OddsSnapshot[];
    },
    async getUpdatedSince() {
      return [] as OddsSnapshot[];
    },
    async getResults() {
      return [] as EventResult[];
    },
  };
}

async function counts() {
  const [row] = await db.execute<{
    events: number;
    teams: number;
    competitions: number;
    classified: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM events WHERE provider = ${PROVIDER}) AS events,
      (SELECT count(*)::int FROM teams) AS teams,
      (SELECT count(*)::int FROM competitions) AS competitions,
      (SELECT count(*)::int FROM events WHERE provider = ${PROVIDER} AND competition_id IS NOT NULL) AS classified
  `);
  return row!;
}

async function duplicates() {
  const [row] = await db.execute<{ dup_events: number; dup_teams: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM (
        SELECT provider_event_id FROM events WHERE provider = ${PROVIDER}
        GROUP BY provider_event_id HAVING count(*) > 1
      ) d) AS dup_events,
      (SELECT count(*)::int FROM (
        SELECT key FROM teams GROUP BY key HAVING count(*) > 1
      ) d) AS dup_teams
  `);
  return row!;
}

async function main() {
  const events = dataset(COUNT);
  const service = new OddsSyncService(stubProvider(events), {
    sport: "football",
    bookmakers: ["Bet365", "1xbet"],
  });

  console.log(`dataset      : ${COUNT} events, ${new Set(events.map((e) => e.home)).size} distinct clubs`);
  console.log(`node         : ${process.version}  platform ${process.platform}`);
  console.log(`provider tag : ${PROVIDER}`);

  const before = await counts();

  const started = process.hrtime.bigint();
  const result = await service.syncFixtures();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const after = await counts();
  const dupes = await duplicates();

  console.log("");
  console.log(`RUNTIME      : ${elapsedMs.toFixed(0)} ms  (${(elapsedMs / COUNT).toFixed(1)} ms/event)`);
  console.log(`upserted     : ${result.upserted}`);
  console.log(`events       : ${before.events} -> ${after.events}`);
  console.log(`teams        : ${before.teams} -> ${after.teams}`);
  console.log(`competitions : ${before.competitions} -> ${after.competitions}`);
  console.log(`classified   : ${after.classified} of ${after.events}`);
  console.log(`duplicates   : events=${dupes.dup_events} teams=${dupes.dup_teams}`);

  // Idempotency: a second identical run must add nothing.
  const secondStart = process.hrtime.bigint();
  await service.syncFixtures();
  const secondMs = Number(process.hrtime.bigint() - secondStart) / 1e6;
  const afterSecond = await counts();

  console.log("");
  console.log(`SECOND RUN   : ${secondMs.toFixed(0)} ms`);
  console.log(`events       : ${after.events} -> ${afterSecond.events} ${afterSecond.events === after.events ? "(idempotent)" : "(GREW — NOT IDEMPOTENT)"}`);
  console.log(`teams        : ${after.teams} -> ${afterSecond.teams} ${afterSecond.teams === after.teams ? "(idempotent)" : "(GREW — NOT IDEMPOTENT)"}`);

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("benchmark failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
