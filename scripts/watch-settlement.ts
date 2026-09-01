/**
 * Watch a bet settle, without being able to settle it.
 *
 *   npm run settle:watch -- <betId>
 *   npm run settle:watch -- <betId> --follow      # re-check every 60s
 *
 * WHY THIS CANNOT CHEAT
 * ---------------------
 * The whole point of an unattended-settlement observation is that a human did
 * not cause the outcome. A monitor that COULD write is therefore not evidence,
 * however carefully it is used — the reader has to take the operator's word for
 * it.
 *
 * So this is read-only three times over:
 *
 *   1. Every statement runs inside `BEGIN ... READ ONLY`. PostgreSQL itself
 *      rejects any INSERT, UPDATE or DELETE with error 25006, so a write is not
 *      prevented by discipline, it is impossible.
 *   2. It imports no settlement service, no wallet service and no provider
 *      client. There is nothing here to call.
 *   3. It never fetches from the odds provider. What it shows is what the
 *      SCHEDULER has already done, which is the thing being observed.
 *
 * It reports the ten facts needed to tell "settled automatically" apart from
 * "settled by someone impatient": bet id, provider event id, kickoff, last
 * poll, next eligible poll, scheduler heartbeat, bet status, wallet balance,
 * payout/refund count, and ledger reconciliation.
 */
import "dotenv/config";
import postgres from "postgres";

const betId = process.argv[2]?.trim();
const follow = process.argv.includes("--follow");

if (!betId || betId.startsWith("--")) {
  console.error("usage: npm run settle:watch -- <betId> [--follow]");
  process.exit(2);
}

const BET_ID: string = betId;

function databaseUrl(): string {
  const url =
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.DIRECT_DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

const client = postgres(databaseUrl(), { max: 1, prepare: false, connect_timeout: 20 });

function money(minor: string | number | null | undefined): string {
  if (minor === null || minor === undefined) return "—";
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}₦${(absolute / 100n).toLocaleString("en-NG")}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`;
}

function when(value: Date | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  const deltaMinutes = Math.round((Date.now() - date.getTime()) / 60_000);
  const relative =
    Math.abs(deltaMinutes) < 1
      ? "just now"
      : deltaMinutes > 0
        ? `${deltaMinutes}m ago`
        : `in ${-deltaMinutes}m`;
  return `${date.toISOString()} (${relative})`;
}

async function report(): Promise<boolean> {
  /*
   * READ ONLY, declared to the database.
   *
   * `postgres.js` exposes `begin` with options; "read only" makes the server
   * reject any write attempted inside this block. If a future edit to this file
   * ever adds an UPDATE, it fails loudly at runtime instead of quietly
   * invalidating the evidence this script exists to produce.
   */
  return client.begin(async (tx) => {
    /*
     * Declared to the SERVER, not merely intended.
     *
     * After this statement PostgreSQL rejects every INSERT, UPDATE and DELETE
     * in this transaction with error 25006. If a future edit adds a write, it
     * fails loudly at runtime rather than quietly invalidating the evidence
     * this script exists to produce.
     */
    await tx.unsafe("SET TRANSACTION READ ONLY");

    const [bet] = await tx<
      {
        id: string;
        status: string;
        stake_minor: string;
        potential_return_minor: string;
        placed_at: Date;
        settled_at: Date | null;
        user_id: string;
        event_id: string;
        provider_event_id: string;
        home: string;
        away: string;
        starts_at: Date;
        event_status: string;
        selection: string;
        odds: string;
        result_last_polled_at: Date | null;
        result_next_poll_at: Date | null;
        has_result: boolean;
      }[]
    >`
      SELECT b.id::text, b.status::text, b.stake_minor::text,
             b.potential_return_minor::text, b.placed_at, b.settled_at,
             b.user_id::text,
             e.id::text AS event_id, e.provider_event_id, e.home, e.away,
             e.starts_at, e.status::text AS event_status,
             e.result_last_polled_at, e.result_next_poll_at,
             s.key AS selection, l.locked_odds_decimal::text AS odds,
             EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = e.id) AS has_result
      FROM bets b
      JOIN bet_legs l ON l.bet_id = b.id
      JOIN selections s ON s.id = l.selection_id
      JOIN markets m ON m.id = s.market_id
      JOIN events e ON e.id = m.event_id
      WHERE b.id = ${BET_ID}::uuid
    `;

    if (!bet) {
      console.error(`no bet with id ${BET_ID}`);
      return true;
    }

    // Scores are period-keyed jsonb, not flat columns: match-result markets
    // settle against `ft` while HT/FT needs `p1`, and one home/away pair
    // cannot express both. The most recent ingestion wins.
    const [result] = await tx<
      { status: string; periods: Record<string, { home: number; away: number }>; provider: string; ingested_at: Date }[]
    >`
      SELECT status::text, periods, provider, ingested_at
      FROM event_results WHERE event_id = ${bet.event_id}::uuid
      ORDER BY ingested_at DESC LIMIT 1
    `;

    const heartbeats = await tx<
      {
        job: string;
        last_success_at: Date | null;
        last_failure_at: Date | null;
        last_error: string | null;
        processed_count: number;
        settled_count: number;
        total_runs: string;
        total_failures: string;
      }[]
    >`
      SELECT job, last_success_at, last_failure_at, last_error,
             processed_count, settled_count,
             total_runs::text, total_failures::text
      FROM job_heartbeats ORDER BY job
    `;

    const wallets = await tx<{ bucket: string; cached_balance_minor: string }[]>`
      SELECT COALESCE(bucket::text, kind::text) AS bucket, cached_balance_minor::text
      FROM wallets WHERE user_id = ${bet.user_id}::uuid ORDER BY 1
    `;

    const payouts = await tx<{ type: string; n: number; total: string }[]>`
      SELECT t.type::text, count(*)::int AS n, COALESCE(sum(e.amount_minor), 0)::text AS total
      FROM ledger_transactions t
      JOIN ledger_entries e ON e.txn_id = t.id AND e.direction = 'CREDIT'
      WHERE t.type IN ('PAYOUT', 'REFUND')
        AND (t.reference = ${BET_ID} OR t.metadata->>'betId' = ${BET_ID})
      GROUP BY t.type
    `;

    const [ledger] = await tx<{ debits: string; credits: string; negative: number }[]>`
      SELECT
        COALESCE(sum(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debits,
        COALESCE(sum(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits,
        (SELECT count(*)::int FROM wallets WHERE cached_balance_minor < 0) AS negative
      FROM ledger_entries
    `;

    const payoutCount = payouts.reduce((sum, row) => sum + Number(row.n), 0);

    console.log("");
    console.log("=".repeat(74));
    console.log(`  ${bet.home} v ${bet.away}    ${new Date().toISOString()}`);
    console.log("=".repeat(74));
    console.log(`  bet id             ${bet.id}`);
    console.log(`  provider event id  ${bet.provider_event_id}`);
    console.log(`  kickoff            ${when(bet.starts_at)}`);
    console.log(`  selection          ${bet.selection} @ ${bet.odds}`);
    console.log(`  stake              ${money(bet.stake_minor)}`);
    console.log(`  potential return   ${money(bet.potential_return_minor)}`);
    console.log("");
    console.log(`  bet status         ${bet.status}${bet.settled_at ? ` (settled ${when(bet.settled_at)})` : ""}`);
    console.log(`  event status       ${bet.event_status}`);
    console.log(
      `  provider result    ${
        result
          ? `${result.status}, ft ${result.periods?.ft?.home ?? "?"}-${result.periods?.ft?.away ?? "?"}` +
            ` via ${result.provider}, ${when(result.ingested_at)}`
          : "not recorded yet"
      }`,
    );
    console.log(`  last poll          ${when(bet.result_last_polled_at)}`);
    console.log(`  next eligible poll ${when(bet.result_next_poll_at)}`);
    console.log("");
    console.log("  scheduler heartbeat");
    if (heartbeats.length === 0) {
      console.log("    (no job has ever recorded a run — is `npm run dev:all` running?)");
    }
    for (const beat of heartbeats) {
      console.log(
        `    ${beat.job.padEnd(22)} success ${when(beat.last_success_at)}` +
          (beat.last_failure_at ? `  | last failure ${when(beat.last_failure_at)}` : ""),
      );
      // Zero processed is meaningful: it means the job RAN and found nothing,
      // which is a different fact from the job not running.
      console.log(
        `    ${" ".repeat(22)} runs ${beat.total_runs} (${beat.total_failures} failed), ` +
          `last run processed ${beat.processed_count}, settled ${beat.settled_count}`,
      );
      if (beat.last_error) console.log(`    ${" ".repeat(22)} error: ${beat.last_error.slice(0, 120)}`);
    }
    console.log("");
    console.log("  wallet");
    for (const wallet of wallets) {
      console.log(`    ${wallet.bucket.padEnd(8)} ${money(wallet.cached_balance_minor)}`);
    }
    console.log("");
    console.log(
      `  payout/refund      ${payoutCount} transaction(s)` +
        (payouts.length > 0
          ? ` — ${payouts.map((p) => `${p.type} x${p.n} ${money(p.total)}`).join(", ")}`
          : ""),
    );
    if (payoutCount > 1) {
      console.log("    !! MORE THAN ONE PAYOUT FOR ONE BET — this is the bug idempotency prevents");
    }
    console.log(
      `  ledger             debits ${money(ledger!.debits)} vs credits ${money(ledger!.credits)} — ` +
        `${ledger!.debits === ledger!.credits ? "BALANCED" : "OUT OF BALANCE"}` +
        `, ${ledger!.negative} negative wallet(s)`,
    );

    const settled = bet.status !== "PENDING";
    console.log("");
    console.log(
      settled
        ? `  DONE — ${bet.status}. Verify the payout count above is exactly ${bet.status === "WON" || bet.status === "VOID" ? "1" : "0"}.`
        : "  still PENDING — leave the scheduler running.",
    );
    return settled;
  });
}

async function main() {
  if (!follow) {
    await report();
    return;
  }
  console.log("following — Ctrl+C to stop. This process only reads.");
  for (;;) {
    const settled = await report();
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

main()
  .catch((error: unknown) => {
    console.error("watch failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => client.end({ timeout: 5 }).catch(() => {}));
