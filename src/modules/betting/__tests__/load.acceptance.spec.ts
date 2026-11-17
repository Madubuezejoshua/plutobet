import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "./helpers";

/**
 * LOAD TEST — the bet placement path specifically (§8).
 *
 * This is not a benchmark. Throughput on an embedded Postgres on a laptop
 * says nothing about production. What it DOES establish is that under
 * sustained concurrent load the money invariants still hold: no drift, no
 * over-committed exposure, no bet without its stake.
 *
 * Correctness under load is the thing that breaks silently. A slow book
 * annoys people; a book that loses count of its own money does not survive
 * certification.
 */

const IP = "102.89.0.1";
const CONCURRENCY = 12;
const BETS_PER_WORKER = 12;

const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

describe("placement under load", () => {
  it("keeps every money invariant under sustained concurrent placement", async () => {
    // Each worker gets its own connection, so these genuinely contend in the
    // database rather than queueing behind a single client.
    const workers = Array.from({ length: CONCURRENCY }, () => context());
    const setup = workers[0]!;

    const stake = 10_000n; // ₦100
    const funding = stake * BigInt(BETS_PER_WORKER) * 2n;

    const accounts = await Promise.all(
      workers.map(async (worker) => ({
        worker,
        ...(await createFundedUser(worker, funding)),
      })),
    );

    // One shared market: every worker competes for the same exposure row,
    // which is the contended path worth measuring.
    const market = await seedMarket(setup, { prices: { home: "2.000" } });
    const startedAt = Date.now();
    const latencies: number[] = [];
    let accepted = 0;
    let refused = 0;

    await Promise.all(
      accounts.map(async ({ worker, userId, walletId }) => {
        for (let i = 0; i < BETS_PER_WORKER; i++) {
          const began = Date.now();
          try {
            await worker.placement.placeBet({
              userId,
              walletId,
              ip: IP,
              stakeMinor: stake,
              idempotencyKey: slipKey(),
              legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
            });
            accepted += 1;
          } catch {
            // Exposure ceiling or contention. A refusal is a valid outcome;
            // what matters is that a refused bet moved no money.
            refused += 1;
          }
          latencies.push(Date.now() - began);
        }
      }),
    );

    const elapsedMs = Date.now() - startedAt;
    const total = CONCURRENCY * BETS_PER_WORKER;
    latencies.sort((a, b) => a - b);

    console.log(
      `[load] ${total} attempts in ${elapsedMs}ms · ` +
        `${accepted} accepted, ${refused} refused · ` +
        `p50 ${percentile(latencies, 50)}ms · p95 ${percentile(latencies, 95)}ms · ` +
        `p99 ${percentile(latencies, 99)}ms`,
    );

    expect(accepted + refused).toBe(total);
    expect(accepted).toBeGreaterThan(0);

    /*
     * The invariant queries below are SCOPED to the wallets this test created.
     *
     * They used to scan every USER wallet in the database. That coupled this
     * test to every other file in the suite — and one of them
     * (wallet/reconciliation.acceptance.spec.ts) deliberately corrupts a
     * wallet's cached balance to prove the reconciler detects drift, and
     * leaves it corrupted. Whenever file ordering put that test first, this
     * one failed on damage it did not cause and was not testing for.
     *
     * Scoping loses nothing: the invariants worth asserting here are about
     * the money THIS test moved.
     */
    // `sql.join` rather than an array parameter: Drizzle's template does not
    // bind a JS array to `= ANY($1::uuid[])`. This is the pattern used
    // elsewhere in the codebase for the same reason.
    const walletIdList = sql.join(
      accounts.map((account) => sql`${account.walletId}::uuid`),
      sql`, `,
    );
    const userIdList = sql.join(
      accounts.map((account) => sql`${account.userId}::uuid`),
      sql`, `,
    );

    // ---- INVARIANT 1: every ledger transaction balances ----
    const unbalanced = await setup.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT lt.id
        FROM ledger_transactions lt
        JOIN ledger_entries le ON le.txn_id = lt.id
        WHERE lt.id IN (
          SELECT txn_id FROM ledger_entries
          WHERE wallet_id IN (${walletIdList})
        )
        GROUP BY lt.id
        HAVING COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'DEBIT'), 0)
            <> COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'CREDIT'), 0)
      ) bad
    `);
    expect(Number(unbalanced[0]!.n)).toBe(0);

    // ---- INVARIANT 2: no cached balance drifted from its ledger ----
    const drifted = await setup.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT w.id
        FROM wallets w
        LEFT JOIN ledger_entries le ON le.wallet_id = w.id
        WHERE w.kind = 'USER' AND w.id IN (${walletIdList})
        GROUP BY w.id, w.cached_balance_minor
        HAVING w.cached_balance_minor <> COALESCE(SUM(
          CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor ELSE -le.amount_minor END
        ), 0)
      ) bad
    `);
    expect(Number(drifted[0]!.n)).toBe(0);

    // ---- INVARIANT 3: exposure matches the bets that were accepted ----
    // Every accepted bet claimed (potential return - stake) of liability, and
    // nothing settled here, so the market's committed liability must equal
    // exactly that. A lost update under contention shows up here.
    const [liability] = await setup.database.execute<{ total: string; ceiling: string }>(sql`
      SELECT total_liability_minor::text AS total, ceiling_minor::text AS ceiling
      FROM exposure WHERE market_id = ${market.marketId}::uuid
    `);
    const expectedLiability = stake * BigInt(accepted); // 2.0 odds -> liability == stake
    expect(BigInt(liability!.total)).toBe(expectedLiability);
    expect(BigInt(liability!.total)).toBeLessThanOrEqual(BigInt(liability!.ceiling));

    // ---- INVARIANT 4: every bet has exactly one stake debit ----
    const orphans = await setup.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM bets b
      LEFT JOIN ledger_transactions lt ON lt.id = b.stake_txn_id
      WHERE lt.id IS NULL
        AND b.user_id IN (${userIdList})
    `);
    expect(Number(orphans[0]!.n)).toBe(0);

    // ---- INVARIANT 5: each user's balance reflects exactly their bets ----
    for (const { worker, userId, walletId } of accounts) {
      const [row] = await worker.database.execute<{ bets: number }>(sql`
        SELECT count(*)::int AS bets FROM bets WHERE user_id = ${userId}::uuid
      `);
      const placedByUser = BigInt(Number(row!.bets));
      expect(await worker.wallet.getBalance(walletId)).toBe(funding - stake * placedByUser);
    }
  }, 600_000);
});
