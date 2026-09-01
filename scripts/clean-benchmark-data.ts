/**
 * Removes synthetic benchmark fixtures from a database.
 *
 *   npm run db:clean-benchmark              # DRY RUN — reports, changes nothing
 *   npm run db:clean-benchmark -- --confirm # actually deletes
 *
 * WHY THIS IS NEEDED
 * ------------------
 * An earlier version of `scripts/bench-sync-fixtures.ts` imported the shared
 * pooled client, so it wrote its generated catalogue into whatever
 * `DATABASE_URL` pointed at — which was the production Neon database. 400
 * invented fixtures ("Grêmio v Arsenal" and similar) are sitting alongside real
 * ones and would appear on the customer-facing board as real matches.
 *
 * The benchmark no longer does this: it starts its own throwaway PostgreSQL
 * unless explicitly pointed elsewhere. This script cleans up what the old one
 * left behind.
 *
 * WHY IT IS A DRY RUN BY DEFAULT
 * ------------------------------
 * It deletes rows from a production database. That is the owner's decision, and
 * an irreversible one, so the default is to report and stop. `--confirm` is a
 * deliberate second act.
 *
 * SAFETY
 * ------
 * - Only providers matching `bench-<digits>` are ever touched. A real provider
 *   name cannot match that pattern.
 * - It REFUSES to delete any event that has a bet against it. If a bet ever
 *   pointed at synthetic data, that is a far more serious problem than clutter,
 *   and deleting the evidence is the wrong response.
 * - One transaction, so a partial delete cannot leave dangling markets.
 *
 * Exit codes: 0 fine, 1 refused because something unexpected was found, 2 error.
 */
import "dotenv/config";
import postgres from "postgres";

const confirm = process.argv.includes("--confirm");

/** Only the benchmark's own tag shape. Nothing else is deletable here. */
const BENCH_PROVIDER = "^bench-[0-9]+$";

function databaseUrl(): string {
  const url =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DIRECT_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("no database URL configured");
  return url;
}

async function main(): Promise<number> {
  const client = postgres(databaseUrl(), { max: 1, prepare: false, connect_timeout: 25 });
  try {
    const providers = await client<{ provider: string; n: number }[]>`
      SELECT provider, count(*)::int AS n FROM events
      WHERE provider ~ ${BENCH_PROVIDER}
      GROUP BY provider ORDER BY provider
    `;

    if (providers.length === 0) {
      console.log("clean-benchmark: no synthetic benchmark fixtures found.");
      return 0;
    }

    const total = providers.reduce((sum, row) => sum + Number(row.n), 0);
    console.log(`clean-benchmark: ${total} synthetic event(s) across ${providers.length} tag(s):`);
    for (const row of providers) console.log(`  ${row.provider}  ${row.n} event(s)`);

    const [risk] = await client<{ bets: number; results: number }[]>`
      SELECT
        (SELECT count(*)::int FROM bets b
           JOIN bet_legs l ON l.bet_id = b.id
           JOIN selections s ON s.id = l.selection_id
           JOIN markets m ON m.id = s.market_id
           JOIN events e ON e.id = m.event_id
          WHERE e.provider ~ ${BENCH_PROVIDER}) AS bets,
        (SELECT count(*)::int FROM event_results r
           JOIN events e ON e.id = r.event_id
          WHERE e.provider ~ ${BENCH_PROVIDER}) AS results
    `;

    console.log(
      `clean-benchmark: ${risk!.bets} bet(s) and ${risk!.results} recorded result(s) reference them`,
    );

    if (Number(risk!.bets) > 0) {
      console.error("");
      console.error("REFUSING TO DELETE: a bet references synthetic data.");
      console.error("That is a data-integrity problem, not clutter. Deleting the events");
      console.error("would destroy the evidence needed to understand how it happened.");
      console.error("Investigate the bets first.");
      return 1;
    }

    if (!confirm) {
      console.log("");
      console.log("DRY RUN — nothing was changed.");
      console.log("Re-run with --confirm to delete these events and their markets.");
      return 0;
    }

    // One transaction: a partial delete would leave markets pointing at events
    // that no longer exist.
    const deleted = await client.begin(async (tx) => {
      await tx`
        DELETE FROM selections WHERE market_id IN (
          SELECT m.id FROM markets m JOIN events e ON e.id = m.event_id
          WHERE e.provider ~ ${BENCH_PROVIDER}
        )
      `;
      await tx`
        DELETE FROM markets WHERE event_id IN (
          SELECT id FROM events WHERE provider ~ ${BENCH_PROVIDER}
        )
      `;
      await tx`
        DELETE FROM odds_snapshots WHERE provider ~ ${BENCH_PROVIDER}
      `;
      await tx`
        DELETE FROM event_results WHERE event_id IN (
          SELECT id FROM events WHERE provider ~ ${BENCH_PROVIDER}
        )
      `;
      const rows = await tx<{ id: string }[]>`
        DELETE FROM events WHERE provider ~ ${BENCH_PROVIDER} RETURNING id
      `;
      return rows.length;
    });

    console.log("");
    console.log(`clean-benchmark: deleted ${deleted} synthetic event(s) and their markets.`);
    console.log("Teams and competitions are left alone: they are shared taxonomy, and a");
    console.log("real fixture may legitimately reference the same club.");
    return 0;
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("clean-benchmark failed:", error instanceof Error ? error.message : error);
    process.exit(2);
  });
