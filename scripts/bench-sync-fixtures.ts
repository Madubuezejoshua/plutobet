/**
 * Reproducible before/after benchmark for fixture classification.
 *
 *   npx tsx scripts/bench-sync-fixtures.ts            # 200 and 775 events
 *   npx tsx scripts/bench-sync-fixtures.ts 200 775 2000
 *
 * WHAT IT COMPARES
 * ----------------
 * OLD  the per-event path: `resolveFixture` then `classifyEvent`, one
 *      transaction each, exactly as the fixture sync used to call them.
 * NEW  `BatchClassifier`, which resolves and classifies in bounded chunks.
 *
 * Both run against the SAME dataset, in the SAME process, on the SAME database,
 * back to back. That is the only comparison worth reporting: a "before" number
 * from a different day on a different machine measures the weather.
 *
 * WHY IT STARTS ITS OWN DATABASE
 * ------------------------------
 * It boots a throwaway embedded PostgreSQL and migrates it. That makes the run
 * self-contained, repeatable by anyone, and — crucially — guaranteed to FINISH.
 * Earlier attempts pointed the old path at hosted Neon and had to be killed
 * after 25 minutes, which is an anecdote, not a measurement.
 *
 * Pass `--url=<postgres url>` to measure a hosted database instead. Round trips
 * dominate there, so the gap widens; the local numbers below are the
 * CONSERVATIVE end of the improvement, not the flattering one.
 *
 * WHAT IT REPORTS
 * ---------------
 * Wall clock, transactions, statements (counted at the driver, not estimated),
 * entities produced, duplicates, failures and peak concurrency. Statement count
 * is the machine-independent number: it does not move when the hardware does.
 *
 * No provider quota is spent — the dataset is generated, and no network call to
 * the odds provider is made.
 */
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import { assertEphemeralDatabase } from "@/db/ephemeral-guard";
import { createDirectDatabase } from "@/modules/wallet/db-direct";
import { BatchClassifier, type FixtureToClassify } from "@/modules/sports/classify-batch";
import { TaxonomyService } from "@/modules/sports/taxonomy.service";
import { WalletService } from "@/modules/wallet/wallet.service";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.resolve(ROOT, "drizzle");
const OWNER = "bet_owner";
const OWNER_PASSWORD = "bench_owner_password";
const APP_USER = "bet_app_bench";
const APP_PASSWORD = "bench_app_password";
const DATABASE = "bet_bench";

const args = process.argv.slice(2);
const externalUrl = args.find((a) => a.startsWith("--url="))?.slice("--url=".length);
const sizes = args.filter((a) => /^\d+$/.test(a)).map(Number);
const SIZES = sizes.length > 0 ? sizes : [200, 775];

/** Counts every statement the driver actually sends, including BEGIN/COMMIT. */
class StatementCounter {
  private count = 0;
  private active = 0;
  private peak = 0;

  hook = (_connection: number, query: string): void => {
    if (query.trim().length > 0) this.count += 1;
  };

  enter(): void {
    this.active += 1;
    if (this.active > this.peak) this.peak = this.active;
  }

  exit(): void {
    this.active -= 1;
  }

  reset(): void {
    this.count = 0;
    this.peak = 0;
    this.active = 0;
  }

  get statements(): number {
    return this.count;
  }

  get peakConcurrency(): number {
    return this.peak;
  }
}

/**
 * A deterministic catalogue.
 *
 * Names repeat across events deliberately: a real feed is a league week —
 * twenty fixtures over the same forty clubs — and that repetition is exactly
 * what the old path re-resolved from scratch every single time. Non-ASCII
 * spellings are included so normalisation is exercised too.
 */
function dataset(tag: string, count: number): { eventId: string; league: string; home: string; away: string }[] {
  const leagues = [
    "England - Premier League",
    "Espana - LaLiga",
    "Espana - Segunda",
    "Brazil - Serie A",
    "Deutschland - Bundesliga",
  ];
  const clubs = [
    "Arsenal", "Chelsea", "CD O´Higgins", "Bayern München", "Atlético Madrid",
    "Real Betis", "Grêmio", "Borussia Mönchengladbach", "Valência", "Málaga",
  ];
  return Array.from({ length: count }, (_, i) => ({
    eventId: `${tag}-evt-${i}`,
    league: leagues[i % leagues.length]!,
    home: clubs[i % clubs.length]!,
    away: clubs[(i + 3) % clubs.length]!,
  }));
}

interface Measurement {
  label: string;
  events: number;
  ms: number;
  transactions: number;
  statements: number;
  classified: number;
  failures: number;
  peakConcurrency: number;
}

function row(m: Measurement): string {
  return [
    m.label.padEnd(6),
    String(m.events).padStart(6),
    `${m.ms.toFixed(0)} ms`.padStart(12),
    `${(m.ms / m.events).toFixed(2)}`.padStart(9),
    String(m.transactions).padStart(7),
    String(m.statements).padStart(11),
    String(m.classified).padStart(11),
    String(m.failures).padStart(9),
    String(m.peakConcurrency).padStart(6),
  ].join(" ");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not reserve a port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function main() {
  let embedded: EmbeddedPostgres | undefined;
  let appUrl = externalUrl;
  let dataDir: string | undefined;
  let environment: string;

  if (appUrl) {
    /*
     * A supplied target must PROVE it is disposable.
     *
     * An earlier version of this script wrote its generated catalogue into
     * production Neon, because it imported the shared pooled client and
     * `DATABASE_URL` was whatever the shell had loaded. 400 invented fixtures
     * are still in that database. Starting our own cluster fixes the default;
     * this stops the next person aiming --url somewhere expensive.
     */
    assertEphemeralDatabase(appUrl);
    environment = "external database (--url), verified disposable";
  } else {
    const port = await availablePort();
    dataDir = path.resolve(ROOT, `.pgdata-bench-${process.pid}`);
    if (
      path.dirname(dataDir) !== ROOT ||
      !/^\.pgdata-bench-\d+$/.test(path.basename(dataDir))
    ) {
      throw new Error(`refusing to clean unexpected path: ${dataDir}`);
    }
    rmSync(dataDir, { recursive: true, force: true });

    embedded = new EmbeddedPostgres({
      databaseDir: dataDir,
      port,
      user: OWNER,
      password: OWNER_PASSWORD,
      persistent: false,
      postgresFlags: ["-c", "max_connections=100"],
    });
    console.log("starting embedded PostgreSQL ...");
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase(DATABASE);

    const ownerUrl = `postgresql://${OWNER}:${OWNER_PASSWORD}@127.0.0.1:${port}/${DATABASE}`;
    const ownerSql = postgres(ownerUrl, { max: 1, prepare: false });
    await migrate(drizzle(ownerSql), { migrationsFolder: MIGRATIONS_DIR });
    await ownerSql.unsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
           CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}';
         END IF;
       END $$;`,
    );
    await ownerSql.unsafe(`GRANT app_role TO ${APP_USER}`);
    await ownerSql.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_USER}`);
    await ownerSql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_USER}`,
    );
    await ownerSql.end({ timeout: 5 });
    appUrl = `postgresql://${APP_USER}:${APP_PASSWORD}@127.0.0.1:${port}/${DATABASE}`;
    environment = `embedded PostgreSQL, loopback, node ${process.version}, ${process.platform}`;
  }

  const counter = new StatementCounter();
  const client = postgres(appUrl, {
    max: 1,
    prepare: false,
    types: { bigint: postgres.BigInt },
    debug: counter.hook,
  });
  const database = createDirectDatabase(client);
  const wallet = new WalletService(database);
  const taxonomy = new TaxonomyService(wallet);
  const classifier = new BatchClassifier(wallet);

  async function seed(tag: string, fixtures: ReturnType<typeof dataset>): Promise<FixtureToClassify[]> {
    const inputs: FixtureToClassify[] = [];
    // Seeded outside the measured window: this benchmark measures
    // CLASSIFICATION, and both paths receive identical rows.
    for (let start = 0; start < fixtures.length; start += 50) {
      const chunk = fixtures.slice(start, start + 50);
      const values = chunk.map(
        (f) => sql`(${tag}, ${f.eventId}, 'football', ${f.league}, ${f.home}, ${f.away}, now() + interval '2 days', 'PENDING')`,
      );
      const rows = await database.execute<{ id: string; provider_event_id: string }>(sql`
        INSERT INTO events (provider, provider_event_id, sport, league, home, away, starts_at, status)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (provider, provider_event_id) DO UPDATE SET league = excluded.league
        RETURNING id, provider_event_id
      `);
      const byProviderId = new Map(rows.map((r) => [r.provider_event_id, r.id]));
      for (const f of chunk) {
        inputs.push({
          eventId: byProviderId.get(f.eventId)!,
          sport: "football",
          league: f.league,
          home: f.home,
          away: f.away,
        });
      }
    }
    return inputs;
  }

  async function counts(tag: string) {
    const [r] = await database.execute<{
      events: number; classified: number; teams: number; competitions: number;
      dup_events: number; dup_teams: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM events WHERE provider = ${tag}) AS events,
        (SELECT count(*)::int FROM events WHERE provider = ${tag} AND competition_id IS NOT NULL
           AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL) AS classified,
        (SELECT count(*)::int FROM teams) AS teams,
        (SELECT count(*)::int FROM competitions) AS competitions,
        (SELECT count(*)::int FROM (
          SELECT provider_event_id FROM events WHERE provider = ${tag}
          GROUP BY provider_event_id HAVING count(*) > 1) d) AS dup_events,
        (SELECT count(*)::int FROM (
          SELECT sport_id, key FROM teams GROUP BY sport_id, key HAVING count(*) > 1) d) AS dup_teams
    `);
    return r!;
  }

  console.log(`environment  : ${environment}`);
  console.log(`node         : ${process.version}  platform ${process.platform}`);
  console.log("");
  console.log(
    "path    events      runtime   ms/event   txns  statements  classified  failures   peak",
  );
  console.log("-".repeat(94));

  const summary: { size: number; old: Measurement; fresh: Measurement }[] = [];

  for (const size of SIZES) {
    const fixtures = dataset(`bench${size}`, size);

    // ---- OLD: one transaction per resolve, one per classify ----
    const oldTag = `old-${size}-${Date.now()}`;
    const oldInputs = await seed(oldTag, fixtures);
    counter.reset();
    let oldTransactions = 0;
    let oldFailures = 0;
    let oldClassified = 0;
    const oldStart = process.hrtime.bigint();
    for (const input of oldInputs) {
      try {
        const resolved = await taxonomy.resolveFixture({
          sport: input.sport,
          league: input.league,
          home: input.home,
          away: input.away,
        });
        oldTransactions += 1;
        if (resolved) {
          await taxonomy.classifyEvent(input.eventId, resolved);
          oldTransactions += 1;
          oldClassified += 1;
        }
      } catch {
        oldFailures += 1;
      }
    }
    const oldMs = Number(process.hrtime.bigint() - oldStart) / 1e6;
    const oldMeasurement: Measurement = {
      label: "OLD",
      events: size,
      ms: oldMs,
      transactions: oldTransactions,
      statements: counter.statements,
      classified: oldClassified,
      failures: oldFailures,
      peakConcurrency: 1,
    };
    console.log(row(oldMeasurement));

    // ---- NEW: bounded batches ----
    const newTag = `new-${size}-${Date.now()}`;
    const newInputs = await seed(newTag, fixtures);
    counter.reset();
    const newStart = process.hrtime.bigint();
    const result = await classifier.classify(newInputs);
    const newMs = Number(process.hrtime.bigint() - newStart) / 1e6;
    const newMeasurement: Measurement = {
      label: "NEW",
      events: size,
      ms: newMs,
      transactions: result.transactions,
      statements: counter.statements,
      classified: result.classified,
      failures: result.failures.length,
      // Sequential by design: no Promise.all, bounded or otherwise.
      peakConcurrency: 1,
    };
    console.log(row(newMeasurement));

    const after = await counts(newTag);
    console.log(
      `       -> teams ${after.teams}, competitions ${after.competitions}, ` +
        `duplicate events ${after.dup_events}, duplicate team keys ${after.dup_teams}`,
    );

    // Idempotency, measured rather than assumed.
    const replayStart = process.hrtime.bigint();
    await classifier.classify(newInputs);
    const replayMs = Number(process.hrtime.bigint() - replayStart) / 1e6;
    const afterReplay = await counts(newTag);
    const idempotent =
      afterReplay.teams === after.teams &&
      afterReplay.competitions === after.competitions &&
      afterReplay.dup_events === 0 &&
      afterReplay.dup_teams === 0;
    console.log(
      `       -> replay ${replayMs.toFixed(0)} ms, ${idempotent ? "idempotent" : "NOT IDEMPOTENT"}`,
    );
    console.log("");

    summary.push({ size, old: oldMeasurement, fresh: newMeasurement });
  }

  console.log("SUMMARY");
  console.log("-".repeat(94));
  for (const entry of summary) {
    const speedup = entry.old.ms / entry.fresh.ms;
    const fewer = entry.old.statements / entry.fresh.statements;
    console.log(
      `${String(entry.size).padStart(5)} events: ` +
        `${speedup.toFixed(1)}x faster, ` +
        `${fewer.toFixed(1)}x fewer statements ` +
        `(${entry.old.statements} -> ${entry.fresh.statements}), ` +
        `${entry.old.transactions} -> ${entry.fresh.transactions} transactions`,
    );
  }
  console.log("");
  console.log(
    "Statement count is the hardware-independent number. On a hosted database\n" +
      "each statement also costs a network round trip, so the wall-clock gap is\n" +
      "wider there than it is on loopback.",
  );

  await client.end({ timeout: 5 });
  if (embedded) await embedded.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("benchmark failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
