/**
 * Verifies a RESTORED database, so a restore drill produces evidence.
 *
 *   npm run db:verify-restore -- --url="postgresql://…restored-branch…"
 *   npm run db:verify-restore                 # verifies the configured database
 *
 * WHAT THIS IS FOR
 * ----------------
 * "An untested backup is not a backup" has been an open item in this project's
 * status documents since the beginning, and it stays open until somebody
 * actually restores and CHECKS. Restoring is the easy half; the half people skip
 * is proving the restored data is coherent — a restore that silently lands
 * mid-transaction is worse than none, because it looks like a recovery.
 *
 * This is the checking half, and it is deliberately usable on any database so
 * the procedure can be rehearsed before it is needed. Point it at a restored
 * Neon branch and it answers, in order:
 *
 *   1. Is the schema complete?              (migrations applied vs on disk)
 *   2. Does the ledger balance?             (debits == credits, globally)
 *   3. Do wallets agree with the ledger?    (cached balance vs derived)
 *   4. Is anything negative?                (a wallet that owes money)
 *   5. Did the business records survive?    (users, bets, audit, settlements)
 *   6. How much was lost?                   (newest row per table = the RPO)
 *
 * READ-ONLY. Every statement runs inside a `READ ONLY` transaction, so this can
 * never be the thing that damages a database somebody is trying to recover.
 *
 * Exit codes: 0 coherent, 1 a check failed, 2 the checker itself failed.
 */
import "dotenv/config";
import postgres from "postgres";
import { readdirSync } from "node:fs";

const urlArg = process.argv.find((a) => a.startsWith("--url="))?.slice("--url=".length);

function databaseUrl(): string {
  const url =
    urlArg?.trim() ||
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DIRECT_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("pass --url=… or configure a database URL");
  return url;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function money(minor: string | number): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}₦${(absolute / 100n).toLocaleString("en-NG")}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`;
}

async function main(): Promise<number> {
  const started = Date.now();
  const client = postgres(databaseUrl(), { max: 1, prepare: false, connect_timeout: 25 });

  try {
    await client.begin(async (tx) => {
      // Nothing here may write. A verification script that can damage the
      // database being recovered is a liability during an incident.
      await tx.unsafe("SET TRANSACTION READ ONLY");

      // ---- 1. schema ----
      const onDisk = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).length;
      const [applied] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations
      `;
      record(
        "schema complete",
        Number(applied!.n) === onDisk,
        `${applied!.n} of ${onDisk} migrations applied`,
      );

      // ---- 2. ledger balances globally ----
      const [ledger] = await tx<{ debits: string; credits: string; entries: number }[]>`
        SELECT
          COALESCE(sum(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debits,
          COALESCE(sum(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits,
          count(*)::int AS entries
        FROM ledger_entries
      `;
      record(
        "ledger balances",
        ledger!.debits === ledger!.credits,
        `${ledger!.entries} entries — debits ${money(ledger!.debits)} vs credits ${money(ledger!.credits)}`,
      );

      // ---- 3. every transaction balances on its own ----
      // A globally balanced ledger can still contain two errors that cancel
      // out. Per-transaction is the check that cannot be fooled that way.
      const [unbalanced] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM (
          SELECT txn_id
          FROM ledger_entries
          GROUP BY txn_id
          HAVING COALESCE(sum(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)
               <> COALESCE(sum(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
        ) d
      `;
      record(
        "every transaction balances",
        Number(unbalanced!.n) === 0,
        `${unbalanced!.n} unbalanced transaction(s)`,
      );

      // ---- 4. wallets agree with the ledger ----
      // The cached balance is a denormalisation. After a restore it is the most
      // likely thing to disagree, because it is written by a trigger.
      const drift = await tx<{ id: string; cached: string; derived: string }[]>`
        SELECT w.id::text,
               w.cached_balance_minor::text AS cached,
               COALESCE(l.derived, 0)::text AS derived
        FROM wallets w
        LEFT JOIN (
          SELECT wallet_id,
                 sum(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END) AS derived
          FROM ledger_entries GROUP BY wallet_id
        ) l ON l.wallet_id = w.id
        WHERE w.cached_balance_minor <> COALESCE(l.derived, 0)
      `;
      record(
        "wallet balances match the ledger",
        drift.length === 0,
        drift.length === 0
          ? "every wallet agrees with its entries"
          : `${drift.length} wallet(s) drifted — first: cached ${money(drift[0]!.cached)} vs derived ${money(drift[0]!.derived)}`,
      );

      // ---- 5. nothing negative ----
      const [negative] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM wallets WHERE cached_balance_minor < 0
      `;
      record("no negative wallet", Number(negative!.n) === 0, `${negative!.n} negative wallet(s)`);

      // ---- 6. business records survived ----
      const [counts] = await tx<
        { users: number; bets: number; audit: number; results: number; settled: number }[]
      >`
        SELECT
          (SELECT count(*)::int FROM users) AS users,
          (SELECT count(*)::int FROM bets) AS bets,
          (SELECT count(*)::int FROM audit_log) AS audit,
          (SELECT count(*)::int FROM event_results) AS results,
          (SELECT count(*)::int FROM bets WHERE status <> 'PENDING') AS settled
      `;
      record(
        "business records present",
        Number(counts!.users) > 0,
        `${counts!.users} user(s), ${counts!.bets} bet(s) (${counts!.settled} settled), ` +
          `${counts!.audit} audit row(s), ${counts!.results} recorded result(s)`,
      );

      // ---- 7. a settled bet still has its payout ----
      // The check that matters to a customer: were people who won still paid?
      const [orphaned] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM bets b
        WHERE b.status = 'WON'
          AND NOT EXISTS (
            SELECT 1 FROM ledger_transactions t
            WHERE t.type = 'PAYOUT'
              AND (t.reference = b.id::text OR t.metadata->>'betId' = b.id::text)
          )
      `;
      record(
        "every won bet has a payout",
        Number(orphaned!.n) === 0,
        `${orphaned!.n} won bet(s) with no payout transaction`,
      );

      // ---- 8. the recovery point ----
      // The newest surviving row IS the effective RPO. Everything after it is
      // what the restore cost, and nobody should have to guess that number.
      const [newest] = await tx<
        { ledger: Date | null; bet: Date | null; audit: Date | null }[]
      >`
        SELECT
          (SELECT max(created_at) FROM ledger_entries) AS ledger,
          (SELECT max(placed_at) FROM bets) AS bet,
          (SELECT max(created_at) FROM audit_log) AS audit
      `;
      const stamps = [newest!.ledger, newest!.bet, newest!.audit].filter(Boolean) as Date[];
      const effective = stamps.length
        ? new Date(Math.max(...stamps.map((d) => new Date(d).getTime())))
        : null;
      record(
        "effective recovery point",
        true,
        effective
          ? `newest surviving row ${effective.toISOString()} — anything after it was lost`
          : "no dated rows found",
      );
    });

    const width = Math.max(...checks.map((c) => c.name.length));
    console.log("");
    console.log("RESTORE VERIFICATION");
    console.log("");
    for (const check of checks) {
      console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`);
    }
    const failed = checks.filter((c) => !c.ok);
    console.log("");
    console.log(`checked in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (failed.length > 0) {
      console.error(`${failed.length} check(s) FAILED — this database is not safe to promote.`);
      return 1;
    }
    console.log("All checks passed. Record the recovery point above in the drill log.");
    return 0;
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("verify-restore failed:", error instanceof Error ? error.message : error);
    process.exit(2);
  });
