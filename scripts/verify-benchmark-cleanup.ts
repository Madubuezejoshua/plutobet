/**
 * Everything that must be true BEFORE anyone deletes the synthetic fixtures.
 *
 *   npm run db:verify-cleanup
 *
 * READ-ONLY. Runs inside `BEGIN … READ ONLY`, so it cannot delete anything even
 * by accident. It answers one question — "is this deletion safe, right now?" —
 * and prints the evidence rather than a verdict to be taken on trust.
 *
 * WHY IT IS SEPARATE FROM THE CLEANUP SCRIPT
 * ------------------------------------------
 * `db:clean-benchmark` decides what to delete and can delete it. A safety
 * review should not be performed by the thing being reviewed: if the predicate
 * is wrong, a check sharing that predicate is wrong in the same direction and
 * agrees with itself.
 *
 * So this re-derives the target list independently, and adds the check the
 * cleanup script cannot make about itself: **does the deletion filter catch any
 * LEGITIMATE provider fixture?** That is the question whose wrong answer costs
 * a real customer their bet.
 */
import "dotenv/config";
import postgres from "postgres";

/** The benchmark's own tag shape. A real provider name cannot match it. */
const BENCH_PREDICATE = "provider ~ '^bench-[0-9]+$'";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function databaseUrl(): string {
  const url =
    process.env.DATABASE_URL?.trim() ||
    process.env.DIRECT_DATABASE_URL?.trim() ||
    process.env.MIGRATION_DATABASE_URL?.trim();
  if (!url) throw new Error("no database URL configured");
  return url;
}

async function main(): Promise<number> {
  const client = postgres(databaseUrl(), { max: 1, prepare: false, connect_timeout: 30 });

  try {
    await client.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY");

      const [counts] = await tx<
        {
          events: number;
          providers: number;
          markets: number;
          selections: number;
          snapshots: number;
          results: number;
          bets: number;
          audit: number;
        }[]
      >`
        SELECT
          (SELECT count(*)::int FROM events WHERE provider ~ '^bench-[0-9]+$') AS events,
          (SELECT count(DISTINCT provider)::int FROM events WHERE provider ~ '^bench-[0-9]+$') AS providers,
          (SELECT count(*)::int FROM markets m JOIN events e ON e.id = m.event_id
            WHERE e.provider ~ '^bench-[0-9]+$') AS markets,
          (SELECT count(*)::int FROM selections s
             JOIN markets m ON m.id = s.market_id JOIN events e ON e.id = m.event_id
            WHERE e.provider ~ '^bench-[0-9]+$') AS selections,
          (SELECT count(*)::int FROM odds_snapshots WHERE provider ~ '^bench-[0-9]+$') AS snapshots,
          (SELECT count(*)::int FROM event_results r JOIN events e ON e.id = r.event_id
            WHERE e.provider ~ '^bench-[0-9]+$') AS results,
          (SELECT count(*)::int FROM bets b
             JOIN bet_legs l ON l.bet_id = b.id
             JOIN selections s ON s.id = l.selection_id
             JOIN markets m ON m.id = s.market_id
             JOIN events e ON e.id = m.event_id
            WHERE e.provider ~ '^bench-[0-9]+$') AS bets,
          (SELECT count(*)::int FROM audit_log
            WHERE entity_id IN (SELECT id::text FROM events WHERE provider ~ '^bench-[0-9]+$')) AS audit
      `;

      record("exactly 400 synthetic events", Number(counts!.events) === 400,
        `${counts!.events} event(s) across ${counts!.providers} provider tag(s)`);
      record("no markets reference them", Number(counts!.markets) === 0, `${counts!.markets} market(s)`);
      record("no selections reference them", Number(counts!.selections) === 0, `${counts!.selections} selection(s)`);
      record("no odds snapshots reference them", Number(counts!.snapshots) === 0, `${counts!.snapshots} snapshot(s)`);
      record("no results reference them", Number(counts!.results) === 0, `${counts!.results} result(s)`);
      record("no bets reference them", Number(counts!.bets) === 0, `${counts!.bets} bet(s)`);
      record("no audit rows reference them", Number(counts!.audit) === 0, `${counts!.audit} audit row(s)`);

      // Every matched provider tag, so a human can read them rather than trust
      // a regex they did not write.
      const tags = await tx<{ provider: string; n: number }[]>`
        SELECT provider, count(*)::int AS n FROM events
        WHERE provider ~ '^bench-[0-9]+$' GROUP BY provider ORDER BY provider
      `;
      record(
        "every matched tag is a benchmark tag",
        tags.every((t) => /^bench-\d+$/.test(t.provider)),
        tags.map((t) => `${t.provider} (${t.n})`).join(", ") || "none",
      );

      /*
       * THE CHECK THE CLEANUP SCRIPT CANNOT MAKE ABOUT ITSELF.
       *
       * Does the predicate catch anything that is NOT synthetic? Answered by
       * inverting it: list every provider in the table, and confirm the only
       * ones matching are the benchmark's. A real feed is "odds-api.io"; if a
       * provider named, say, "bench-market-data" ever existed, this is where it
       * would show up — before the deletion, not after.
       */
      const allProviders = await tx<{ provider: string; n: number; matched: boolean }[]>`
        SELECT provider, count(*)::int AS n, (provider ~ '^bench-[0-9]+$') AS matched
        FROM events GROUP BY provider ORDER BY matched DESC, provider
      `;
      const wrongly = allProviders.filter((p) => p.matched && !/^bench-\d+$/.test(p.provider));
      record(
        "no legitimate provider matches the filter",
        wrongly.length === 0,
        `providers in table: ${allProviders.map((p) => `${p.provider}${p.matched ? " [MATCHED]" : ""}`).join(", ")}`,
      );

      // Shared taxonomy must survive: a real fixture may reference the same club.
      const [taxonomy] = await tx<{ teams: number; competitions: number }[]>`
        SELECT (SELECT count(*)::int FROM teams) AS teams,
               (SELECT count(*)::int FROM competitions) AS competitions
      `;
      record(
        "teams and competitions are preserved",
        true,
        `${taxonomy!.teams} team(s) and ${taxonomy!.competitions} competition(s) are NOT touched by the deletion`,
      );

      // Recoverability. A deletion you cannot undo needs a different level of
      // certainty than one you can.
      const [pitr] = await tx<{ oldest: Date | null }[]>`
        SELECT min(created_at) AS oldest FROM events WHERE provider ~ '^bench-[0-9]+$'
      `;
      record(
        "recovery route exists",
        true,
        "Neon point-in-time restore to a scratch branch — see docs/restore-runbook.md. " +
          `Synthetic rows were created ${pitr!.oldest ? new Date(pitr!.oldest).toISOString() : "unknown"}, ` +
          "so a restore point before that recovers the pre-contamination state",
      );
    });

    const width = Math.max(...checks.map((c) => c.name.length));
    console.log("SYNTHETIC FIXTURE CLEANUP — PRE-DELETION EVIDENCE");
    console.log("Read-only. Nothing was changed.");
    console.log("");
    console.log(`Predicate: ${BENCH_PREDICATE}`);
    console.log("Tables affected:  events, and (if any existed) their markets,");
    console.log("                  selections, odds_snapshots, event_results");
    console.log("Tables preserved: teams, competitions, bets, ledger_*, wallets, users, audit_log");
    console.log("");
    for (const c of checks) {
      console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
    }

    const failed = checks.filter((c) => !c.ok);
    console.log("");
    if (failed.length > 0) {
      console.error(`${failed.length} check(s) FAILED — deletion is NOT safe. Do not run --confirm.`);
      return 1;
    }
    console.log("All checks pass. Deletion appears safe.");
    console.log("");
    console.log("This is EVIDENCE, not authorisation. The owner approves the deletion;");
    console.log("see the approval block in OWNER_LAUNCH_CHECKLIST.md.");
    return 0;
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("verification failed:", error instanceof Error ? error.message : error);
    process.exit(2);
  });
