import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { betLegs, bets, exposure } from "@/modules/betting/schema";
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

/** Counts PAYOUT/REFUND ledger legs credited to a wallet. */
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

async function ingestAndSettle(
  ctx: BettingContext,
  settlement: SettlementService,
  eventId: string,
  result: MatchResult,
): Promise<void> {
  await settlement.ingestResult({ eventId, provider: "test-provider", result });
  for (const betId of await settlement.findPendingBetIds(eventId)) {
    await settlement.settleBet(betId);
  }
}

describe("settlement", () => {
  // THE PHASE 4 ACCEPTANCE CRITERION.
  it("replaying the same result feed 5 times pays a winning bet exactly once", async () => {
    const ctx = context();
    const settlement = new SettlementService(ctx.wallet);

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
    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n);

    const result: MatchResult = { status: "SETTLED", periods: { ft: { home: 2, away: 0 } } };

    // Five deliveries of the same feed — duplicates are the normal case, not
    // the exception.
    for (let i = 0; i < 5; i++) {
      await ingestAndSettle(ctx, settlement, market.eventId, result);
    }

    // 900,000 + one 200,000 payout. Five payouts would read 1,700,000.
    expect(await ctx.wallet.getBalance(walletId)).toBe(1_100_000n);
    expect(await payoutLegCount(ctx, walletId)).toBe(1);

    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("WON");
    expect(row!.settledAt).not.toBeNull();

    // All five deliveries are retained as evidence even though only the first
    // moved money.
    const ingested = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM event_results WHERE event_id = ${market.eventId}::uuid
    `);
    expect(Number(ingested[0]!.n)).toBe(5);
  }, 120_000);

  it("settles a losing bet without paying anything", async () => {
    const ctx = context();
    const settlement = new SettlementService(ctx.wallet);
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

    await ingestAndSettle(ctx, settlement, market.eventId, {
      status: "SETTLED",
      periods: { ft: { home: 0, away: 3 } },
    });

    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n);
    expect(await payoutLegCount(ctx, walletId)).toBe(0);
    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("LOST");
  }, 120_000);

  it("refunds the stake when the match is cancelled", async () => {
    const ctx = context();
    const settlement = new SettlementService(ctx.wallet);
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

    await ingestAndSettle(ctx, settlement, market.eventId, {
      status: "CANCELLED",
      periods: { ft: { home: 1, away: 0 } },
    });

    // Stake back, exactly — not the 200,000 the bet would have won.
    expect(await ctx.wallet.getBalance(walletId)).toBe(1_000_000n);
    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("VOID");

    const [leg] = await ctx.database
      .select()
      .from(betLegs)
      .where(eq(betLegs.betId, placed.betId));
    expect(leg!.result).toBe("VOID");
  }, 120_000);

  it("releases the market exposure the bet reserved at placement", async () => {
    const ctx = context();
    const settlement = new SettlementService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    const claimed = await ctx.database
      .select({ total: exposure.totalLiabilityMinor })
      .from(exposure)
      .where(eq(exposure.marketId, market.marketId));
    expect(claimed[0]!.total).toBe(100_000n);

    await ingestAndSettle(ctx, settlement, market.eventId, {
      status: "SETTLED",
      periods: { ft: { home: 0, away: 1 } },
    });

    // Without release, exposure only ever ratchets up and the market stops
    // accepting bets forever.
    const released = await ctx.database
      .select({ total: exposure.totalLiabilityMinor })
      .from(exposure)
      .where(eq(exposure.marketId, market.marketId));
    expect(released[0]!.total).toBe(0n);
  }, 120_000);

  it("recalculates an accumulator with a void leg at odds 1.0", async () => {
    const ctx = context();
    const settlement = new SettlementService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);

    const a = await seedMarket(ctx, { prices: { home: "2.000" } });
    const b = await seedMarket(ctx, { prices: { home: "3.000" } });
    const c = await seedMarket(ctx, { prices: { home: "1.500" } });

    await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [
        { selectionId: a.selectionIds.home!, odds: "2.000" },
        { selectionId: b.selectionIds.home!, odds: "3.000" },
        { selectionId: c.selectionIds.home!, odds: "1.500" },
      ],
    });

    const won: MatchResult = { status: "SETTLED", periods: { ft: { home: 1, away: 0 } } };
    // The middle leg's match is abandoned.
    await settlement.ingestResult({ eventId: a.eventId, provider: "t", result: won });
    await settlement.ingestResult({
      eventId: b.eventId,
      provider: "t",
      result: { status: "CANCELLED", periods: {} },
    });
    await settlement.ingestResult({ eventId: c.eventId, provider: "t", result: won });

    for (const betId of await settlement.findPendingBetIds(a.eventId)) {
      await settlement.settleBet(betId);
    }

    // 2.0 * 1.0 * 1.5 = 3.0 -> 300,000. Not 9.0 (900,000), and not a loss.
    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n + 300_000n);
  }, 120_000);

  it("leaves a bet pending when one of its events has no result yet", async () => {
    const ctx = context();
    const settlement = new SettlementService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);

    const a = await seedMarket(ctx, { prices: { home: "2.000" } });
    const b = await seedMarket(ctx, { prices: { home: "3.000" } });

    const placed = await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [
        { selectionId: a.selectionIds.home!, odds: "2.000" },
        { selectionId: b.selectionIds.home!, odds: "3.000" },
      ],
    });

    // Only the first match has finished.
    await settlement.ingestResult({
      eventId: a.eventId,
      provider: "t",
      result: { status: "SETTLED", periods: { ft: { home: 1, away: 0 } } },
    });

    await expect(settlement.settleBet(placed.betId)).rejects.toThrow();

    // Settling half an accumulator would either pay a bet that can still lose
    // or kill one that can still win.
    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("PENDING");
    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n);
  }, 120_000);

  it("closes the event's markets so nothing can be placed on a finished match", async () => {
    const ctx = context();
    const settlement = new SettlementService(ctx.wallet);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    await settlement.ingestResult({
      eventId: market.eventId,
      provider: "t",
      result: { status: "SETTLED", periods: { ft: { home: 1, away: 0 } } },
    });
    await settlement.closeEventMarkets(market.eventId, false);

    const rows = await ctx.database.execute<{ status: string }>(sql`
      SELECT status::text AS status FROM markets WHERE id = ${market.marketId}::uuid
    `);
    expect(rows[0]!.status).toBe("SETTLED");
  }, 120_000);
});
