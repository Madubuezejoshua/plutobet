/**
 * Returns liability that a duplicate placement reserved and nothing released.
 *
 *   npm run db:repair-exposure                      # DRY RUN, changes nothing
 *   npm run db:repair-exposure -- --expect=<hash> --confirm
 *
 * WHAT WENT WRONG
 * ---------------
 * Placement claims exposure BEFORE it can detect an idempotent replay — it has
 * to, because the global lock order is exposure-then-wallet and inverting it
 * would deadlock against settlement. So a re-submitted slip claimed the
 * liability a second time against every market on it, and created no second bet
 * for settlement to release.
 *
 * The code defect is fixed (the replay path now releases exactly what that
 * attempt claimed, with tests). This script deals with the rows the defect left
 * behind, which no amount of new code will clear on its own.
 *
 * THE INVARIANT
 * -------------
 *   A market with no PENDING bets must hold zero liability.
 *
 * Exposure is a RISK LIMIT, not money: it caps what the book may stand to lose
 * on one market. Residual liability therefore moves no balance and loses no
 * customer a kobo — it silently consumes a ceiling until the market starts
 * refusing honest bets for a liability nobody carries. That is why this repair
 * touches the `exposure` table and NOTHING else. No wallet, no ledger entry, no
 * bet. Verified before writing this: the ledger nets to zero and every affected
 * bet has exactly one payout.
 *
 * WHY IT REFUSES WITHOUT --expect
 * -------------------------------
 * A dry run and a confirmed run are separate invocations, and the database can
 * change between them. The dry run prints a fingerprint of exactly what it saw;
 * `--confirm` requires it back and refuses if the rows have moved. Approving a
 * repair you have read and applying one you have not are different acts.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import postgres from "postgres";

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const EXPECTED = args.find((a) => a.startsWith("--expect="))?.slice("--expect=".length);

interface Residual {
  marketId: string;
  eventId: string;
  marketKey: string;
  fixture: string;
  liabilityMinor: bigint;
  pendingBets: number;
}

function naira(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? "-" : ""}₦${(abs / 100n).toLocaleString("en-NG")}.${(abs % 100n)
    .toString()
    .padStart(2, "0")}`;
}

/**
 * A fingerprint of exactly what was seen.
 *
 * Market ids and amounts only. If either changes, the confirmed run is acting
 * on a different situation than the one that was approved.
 */
function fingerprint(rows: Residual[]): string {
  const canonical = rows
    .map((r) => `${r.marketId}:${r.liabilityMinor.toString()}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function databaseUrl(): string {
  const url =
    process.env.DIRECT_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    process.env.MIGRATION_DATABASE_URL?.trim();
  if (!url) throw new Error("no database URL configured");
  return url;
}

/**
 * Every market holding liability with no pending bet to justify it.
 *
 * `pendingBets` is selected rather than assumed: it is the condition the whole
 * repair rests on, and re-deriving it inside the write transaction is what
 * makes a race harmless.
 */
const RESIDUAL_QUERY = `
  SELECT x.market_id::text  AS market_id,
         m.event_id::text   AS event_id,
         m.key              AS market_key,
         e.home || ' v ' || e.away AS fixture,
         x.total_liability_minor::text AS liability,
         (SELECT count(DISTINCT b.id)::int
            FROM bets b
            JOIN bet_legs l ON l.bet_id = b.id
            JOIN selections s ON s.id = l.selection_id
           WHERE s.market_id = x.market_id AND b.status = 'PENDING') AS pending_bets
  FROM exposure x
  JOIN markets m ON m.id = x.market_id
  JOIN events e ON e.id = m.event_id
  WHERE x.total_liability_minor > 0
  ORDER BY x.market_id
`;

async function main(): Promise<number> {
  const client = postgres(databaseUrl(), { max: 1, prepare: false, connect_timeout: 30 });

  try {
    const raw = await client.unsafe(RESIDUAL_QUERY);
    const all: Residual[] = raw.map((r) => ({
      marketId: String(r.market_id),
      eventId: String(r.event_id),
      marketKey: String(r.market_key),
      fixture: String(r.fixture),
      liabilityMinor: BigInt(String(r.liability)),
      pendingBets: Number(r.pending_bets),
    }));

    const residual = all.filter((r) => r.pendingBets === 0);
    const live = all.filter((r) => r.pendingBets > 0);

    console.log("RESIDUAL EXPOSURE REPAIR");
    console.log("");
    console.log(`  markets holding liability : ${all.length}`);
    console.log(`  with a PENDING bet (leave alone) : ${live.length}`);
    console.log(`  with NO pending bet (repairable) : ${residual.length}`);
    console.log("");

    for (const row of live) {
      console.log(`  KEEP    ${row.marketId}  ${naira(row.liabilityMinor)}  ${row.fixture} ` +
        `(${row.pendingBets} pending bet(s) — this liability is real)`);
    }
    for (const row of residual) {
      console.log(`  REPAIR  ${row.marketId}  ${naira(row.liabilityMinor)}  ${row.fixture} [${row.marketKey}]`);
    }

    const total = residual.reduce((sum, r) => sum + r.liabilityMinor, 0n);
    const hash = fingerprint(residual);
    console.log("");
    console.log(`  total to release : ${naira(total)}`);
    console.log(`  fingerprint      : ${hash}`);
    console.log("");

    if (residual.length === 0) {
      console.log("Nothing to repair. The invariant already holds.");
      return 0;
    }

    if (!CONFIRM) {
      console.log("DRY RUN — nothing was changed.");
      console.log("");
      console.log("To apply, re-run with the fingerprint you just read:");
      console.log(`  npm run db:repair-exposure -- --expect=${hash} --confirm`);
      console.log("");
      console.log("It touches the exposure table ONLY. No wallet, ledger entry or bet");
      console.log("is read for update or written.");
      return 0;
    }

    if (!EXPECTED) {
      console.error("REFUSED: --confirm requires --expect=<fingerprint> from a dry run.");
      console.error("Applying a repair nobody read is how a repair becomes an incident.");
      return 1;
    }
    if (EXPECTED !== hash) {
      console.error(`REFUSED: the data has changed since that dry run.`);
      console.error(`  approved fingerprint : ${EXPECTED}`);
      console.error(`  current fingerprint  : ${hash}`);
      console.error("Re-run the dry run, read it, and approve the new state.");
      return 1;
    }

    /*
     * One transaction, rows locked in a deterministic order.
     *
     * `FOR UPDATE` on the exposure rows, ordered by market id — the same
     * ascending order placement and settlement use — so this cannot deadlock
     * against a bet being placed or settled while it runs.
     *
     * The pending-bet condition is re-checked INSIDE the lock. If somebody
     * places a bet on one of these markets between the read above and this
     * write, that market's liability becomes legitimate and is skipped.
     */
    const applied = await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE app_role");
      const done: { marketId: string; before: bigint; after: bigint }[] = [];

      for (const row of residual.sort((a, b) => a.marketId.localeCompare(b.marketId))) {
        const [locked] = await tx<{ liability: string; pending: number }[]>`
          SELECT x.total_liability_minor::text AS liability,
                 (SELECT count(DISTINCT b.id)::int
                    FROM bets b
                    JOIN bet_legs l ON l.bet_id = b.id
                    JOIN selections s ON s.id = l.selection_id
                   WHERE s.market_id = x.market_id AND b.status = 'PENDING') AS pending
          FROM exposure x
          WHERE x.market_id = ${row.marketId}::uuid
          FOR UPDATE
        `;
        if (!locked) continue;

        const before = BigInt(locked.liability);
        if (Number(locked.pending) > 0) {
          console.warn(`  SKIPPED ${row.marketId}: a bet was placed since the dry run`);
          continue;
        }
        // Idempotent: already zero means a previous run did this.
        if (before === 0n) continue;
        if (before !== row.liabilityMinor) {
          throw new Error(
            `market ${row.marketId} changed under the lock ` +
              `(expected ${row.liabilityMinor}, found ${before}) — refusing`,
          );
        }

        await tx`
          UPDATE exposure SET total_liability_minor = 0, updated_at = now()
          WHERE market_id = ${row.marketId}::uuid
        `;

        /*
         * The audit row, in the SAME transaction as the correction.
         *
         * A risk limit that moves with no record of who moved it or why is the
         * kind of thing an auditor asks about first, and "a script did it" is
         * only acceptable when the script says so in the record.
         */
        await tx`
          INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id, reason, before, after, ip)
          VALUES (
            'SYSTEM', NULL, 'EXPOSURE_RESIDUAL_REPAIRED', 'market', ${row.marketId},
            ${'liability reserved by a duplicate placement and never released; ' +
              'no pending bet on this market. Exposure is a risk limit, not money — ' +
              'no wallet or ledger row was touched'},
            ${JSON.stringify({ totalLiabilityMinor: before.toString() })}::jsonb,
            ${JSON.stringify({ totalLiabilityMinor: "0", fixture: row.fixture })}::jsonb,
            NULL
          )
        `;

        done.push({ marketId: row.marketId, before, after: 0n });
      }
      return done;
    });

    console.log("");
    console.log(`Repaired ${applied.length} market(s):`);
    for (const row of applied) {
      console.log(`  ${row.marketId}  ${naira(row.before)} -> ${naira(row.after)}`);
    }

    // Post-repair reconciliation, read back from the database rather than
    // assumed from what we just wrote.
    const after = await client.unsafe(RESIDUAL_QUERY);
    const stillResidual = after.filter((r) => Number(r.pending_bets) === 0);
    console.log("");
    console.log(`Post-repair: ${stillResidual.length} market(s) still holding unjustified liability.`);
    if (stillResidual.length > 0) {
      console.error("The invariant does NOT hold. Investigate before doing anything else.");
      return 1;
    }
    console.log("Invariant holds: no market carries liability without a pending bet.");
    return 0;
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("repair failed:", error instanceof Error ? error.message : error);
    process.exit(2);
  });
