import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { bets } from "@/modules/betting/schema";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { SettlementService } from "../settlement.service";
import type { MatchResult } from "../resolve";

/**
 * CHAOS TESTS (§8).
 *
 * "Kill the database mid-settlement, verify no double payouts."
 *
 * Killing the whole cluster would take the test harness down with it, so
 * these sever the CONNECTION a settlement is running on — from the database
 * side, using pg_terminate_backend, which is what the application actually
 * experiences during a Neon failover, a rolling restart, or an OOM kill. The
 * transaction dies mid-flight without a chance to clean up, which is exactly
 * the situation where a naive settlement pays twice.
 */

const IP = "102.89.0.1";
const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

const WON: MatchResult = { status: "SETTLED", periods: { ft: { home: 2, away: 0 } } };

async function payoutLegCount(ctx: BettingContext, walletId: string): Promise<number> {
  const rows = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt.id = le.txn_id
    WHERE le.wallet_id = ${walletId}::uuid
      AND le.direction = 'CREDIT'
      AND lt.type IN ('PAYOUT', 'REFUND')
  `);
  return Number(rows[0]?.n ?? 0);
}

/** Severs every other connection to the test database, mid-flight. */
async function severConnections(killer: BettingContext): Promise<void> {
  await killer.database.execute(sql`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state = 'idle in transaction'
  `);
}

describe("settlement survives a connection kill", () => {
  it("never pays twice when the connection dies mid-settlement", async () => {
    const ctx = context();
    const killer = context();
    const service = new SettlementService(ctx.wallet);

    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const placed = await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    await service.ingestResult({ eventId: market.eventId, provider: "t", result: WON });

    // Settle while the connection is being torn out from under it. Whether
    // the kill lands before or after commit is genuinely racy — that is the
    // point. Both outcomes must be safe.
    const settling = service.settleBet(placed.betId).catch(() => "killed" as const);
    await severConnections(killer);
    await settling;

    // Whatever happened, the bet is either untouched or paid exactly once.
    // A torn write that credited without marking the bet settled would show
    // up here as a payout on a still-PENDING bet.
    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    const payouts = await payoutLegCount(ctx, walletId);

    if (row!.status === "PENDING") {
      expect(payouts).toBe(0);
      expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n);
    } else {
      expect(row!.status).toBe("WON");
      expect(payouts).toBe(1);
      expect(await ctx.wallet.getBalance(walletId)).toBe(1_100_000n);
    }

    // Now retry, as the job queue would after the failure. This must
    // converge on exactly one payout regardless of which side of the commit
    // the kill landed.
    await service.settleBet(placed.betId).catch(() => undefined);
    await service.settleBet(placed.betId).catch(() => undefined);

    expect(await payoutLegCount(ctx, walletId)).toBe(1);
    expect(await ctx.wallet.getBalance(walletId)).toBe(1_100_000n);
  }, 180_000);

  it("leaves no partial settlement behind after repeated kills", async () => {
    const ctx = context();
    const killer = context();
    const service = new SettlementService(ctx.wallet);

    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const placed = await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 200_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });
    await service.ingestResult({ eventId: market.eventId, provider: "t", result: WON });

    // Several interleaved attempts and kills, as a flapping database would
    // produce.
    for (let attempt = 0; attempt < 3; attempt++) {
      const settling = service.settleBet(placed.betId).catch(() => undefined);
      await severConnections(killer);
      await settling;
    }
    await service.settleBet(placed.betId).catch(() => undefined);

    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("WON");
    expect(await payoutLegCount(ctx, walletId)).toBe(1);
    // 5,000,000 - 200,000 stake + 400,000 payout.
    expect(await ctx.wallet.getBalance(walletId)).toBe(5_200_000n);

    // The ledger must still balance after all that — a torn transaction that
    // wrote one leg and not its counterpart would surface here.
    const unbalanced = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT lt.id
        FROM ledger_transactions lt
        JOIN ledger_entries le ON le.txn_id = lt.id
        GROUP BY lt.id
        HAVING COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'DEBIT'), 0)
            <> COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'CREDIT'), 0)
      ) bad
    `);
    expect(Number(unbalanced[0]!.n)).toBe(0);
  }, 180_000);
});
