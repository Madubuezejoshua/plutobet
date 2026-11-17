import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "./helpers";

/**
 * A duplicate submit must not reserve risk twice.
 *
 * FOUND ON A REAL BET. After the stranded winner was recovered and paid, its
 * market still held exactly `potential_return - stake` of liability. One bet,
 * one settlement, one release — and a residue the size of a second claim.
 *
 * The cause: the replay is detected AFTER exposure is claimed. It has to be,
 * because the global lock order is exposure-then-wallet and inverting it would
 * deadlock against settlement. So a re-submitted slip claimed the liability
 * again against every market on it, and created no second bet that settlement
 * could ever release.
 *
 * The consequence is slow and quiet: a market's ceiling exists to cap risk, and
 * every double-tapped button permanently consumes a slice of it. Eventually the
 * market refuses honest bets to protect against liability nobody is carrying.
 */

const ctx: BettingContext = createBettingContext();

afterAll(async () => {
  await closeBettingContexts([ctx]);
});

async function liability(marketId: string): Promise<bigint> {
  const [row] = await ctx.database.execute<{ n: string }>(sql`
    SELECT COALESCE(total_liability_minor, 0)::text AS n
    FROM exposure WHERE market_id = ${marketId}::uuid
  `);
  return BigInt(row?.n ?? "0");
}

describe("exposure on a duplicate submit", () => {
  it("claims the liability once, however many times the slip is resubmitted", async () => {
    const market = await seedMarket(ctx, { prices: { home: "2.150", draw: "3.500", away: "4.000" } });
    const { userId, walletId } = await createFundedUser(ctx, 100_000n);
    const key = slipKey();

    const first = await ctx.placement.placeBet({
      userId,
      walletId,
      ip: "102.89.0.1",
      stakeMinor: 20_000n,
      idempotencyKey: key,
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.150" }],
    });
    const afterFirst = await liability(market.marketId);
    // 20,000 at 2.150 returns 43,000, so the book stands to lose 23,000.
    expect(afterFirst).toBe(23_000n);

    // The double-tapped button.
    const replay = await ctx.placement.placeBet({
      userId,
      walletId,
      ip: "102.89.0.1",
      stakeMinor: 20_000n,
      idempotencyKey: key,
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.150" }],
    });

    expect(replay.betId).toBe(first.betId);
    // The number that was wrong: it used to be 46,000 here.
    expect(await liability(market.marketId)).toBe(23_000n);
  });

  it("stays correct after several resubmissions", async () => {
    const market = await seedMarket(ctx, { prices: { home: "2.150", draw: "3.500", away: "4.000" } });
    const { userId, walletId } = await createFundedUser(ctx, 100_000n);
    const key = slipKey();
    const slip = {
      userId,
      walletId,
      ip: "102.89.0.1",
      stakeMinor: 20_000n,
      idempotencyKey: key,
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.150" }],
    };

    const first = await ctx.placement.placeBet(slip);
    for (let i = 0; i < 4; i += 1) {
      const again = await ctx.placement.placeBet(slip);
      expect(again.betId).toBe(first.betId);
    }

    // Five submissions, one bet, one claim. Before the fix this was 115,000
    // and the ceiling would have been consumed five times over.
    expect(await liability(market.marketId)).toBe(23_000n);
  });

  it("releases nothing extra for a genuinely new bet on the same market", async () => {
    const market = await seedMarket(ctx, { prices: { home: "2.150", draw: "3.500", away: "4.000" } });
    const { userId, walletId } = await createFundedUser(ctx, 200_000n);

    await ctx.placement.placeBet({
      userId, walletId, ip: "102.89.0.1", stakeMinor: 20_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.150" }],
    });
    await ctx.placement.placeBet({
      userId, walletId, ip: "102.89.0.1", stakeMinor: 20_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.150" }],
    });

    // Two DIFFERENT bets must still reserve twice. The fix must not turn a
    // genuine second bet into a free one — that would understate real risk,
    // which is the more dangerous direction of this mistake.
    expect(await liability(market.marketId)).toBe(46_000n);
  });
});
