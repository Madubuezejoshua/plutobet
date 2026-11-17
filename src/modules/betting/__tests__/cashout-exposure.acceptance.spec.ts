import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { SettlementService } from "@/modules/settlement/settlement.service";
import { CashOutService } from "../cashout.service";
import { bets, exposure } from "../schema";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "./helpers";

/**
 * Exposure accounting across cash-out and settlement.
 *
 * WHAT EXPOSURE IS. A risk ceiling, not a balance. Placement claims
 * `potential_return - stake` against every market on the slip, and that claim
 * has to be given back exactly once — no more, no less — however the bet ends.
 *
 * Releasing it TWICE is the dangerous direction. The release is floored at zero
 * by `GREATEST`, so an over-release does not go negative; it silently reports a
 * market as carrying no liability while other customers' bets on it still do.
 * The ceiling then admits risk it was configured to refuse, and nothing
 * anywhere raises an error.
 *
 * Releasing it too LITTLE is merely wasteful: the market's ceiling stays partly
 * consumed by a bet that has ended. That is the failure these tests tolerate if
 * rounding forces a choice, and it is why every division here truncates.
 *
 * The four ways a bet can end, and what each must release:
 *
 *   settled (won/lost/void)   the whole claim
 *   cashed out in full        the whole claim
 *   cashed out in part        that portion, and settlement releases the rest
 *   cashed out to zero stake  the whole claim, across however many parts
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

/** ₦1,000 staked at 4.000 — a claim of `potential_return - stake` = ₦3,000. */
const STAKE = 100_000n;
const CLAIM = 300_000n;

async function pendingBet(ctx: BettingContext) {
  const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
  const market = await seedMarket(ctx, { prices: { home: "4.000" } });
  const placed = await ctx.placement.placeBet({
    userId,
    walletId,
    ip: IP,
    stakeMinor: STAKE,
    idempotencyKey: slipKey(),
    legs: [{ selectionId: market.selectionIds.home!, odds: "4.000" }],
  });
  return { userId, walletId, market, placed };
}

async function liabilityOf(ctx: BettingContext, marketId: string): Promise<bigint> {
  const [row] = await ctx.database
    .select({ total: exposure.totalLiabilityMinor })
    .from(exposure)
    .where(eq(exposure.marketId, marketId));
  return row?.total ?? 0n;
}

function cashOut(ctx: BettingContext) {
  return new CashOutService(ctx.wallet, { marginBasisPoints: 500, minimumOfferMinor: 1n });
}

/**
 * Settles the event through the real pipeline.
 *
 * The result is ingested and the bet settled by the service the scheduler
 * calls, rather than by writing a status. A test that sets `status = 'WON'`
 * proves nothing about the code that has to do it in production.
 */
async function settleThroughPipeline(
  ctx: BettingContext,
  eventId: string,
  betId: string,
  homeScore: number,
  awayScore: number,
) {
  const settlement = new SettlementService(ctx.wallet);
  await settlement.ingestResult({
    eventId,
    provider: "test-provider",
    result: {
      status: "SETTLED",
      periods: { ft: { home: homeScore, away: awayScore } },
    },
  });
  return settlement.settleBet(betId);
}

describe("exposure is released exactly once", () => {
  it("releases the whole claim when a bet settles", async () => {
    const ctx = context();
    const { market, placed } = await pendingBet(ctx);

    expect(await liabilityOf(ctx, market.marketId)).toBe(CLAIM);

    await settleThroughPipeline(ctx, market.eventId, placed.betId, 3, 0);

    expect(await liabilityOf(ctx, market.marketId)).toBe(0n);
  }, 120_000);

  it("releases the whole claim when a bet is cashed out in full", async () => {
    const ctx = context();
    const { userId, market, placed } = await pendingBet(ctx);

    await cashOut(ctx).cashOut({ betId: placed.betId, userId, ip: IP });

    expect(await liabilityOf(ctx, market.marketId)).toBe(0n);
  }, 120_000);

  /**
   * THE DEFECT THIS FILE WAS WRITTEN FOR.
   *
   * A partial cash-out releases its proportional slice. The bet stays PENDING,
   * so settlement runs later and releases the FULL original claim again — the
   * slice is given back twice, and the market reads as carrying no liability
   * while other bets on it still do.
   *
   * Half the stake is bought back here, so the correct total release is
   * exactly the claim: ₦1,500 at cash-out and ₦1,500 at settlement.
   */
  it("does not release a partial cash-out's slice twice at settlement", async () => {
    const ctx = context();
    const { userId, market, placed } = await pendingBet(ctx);

    await cashOut(ctx).cashOutPartial({
      betId: placed.betId,
      userId,
      ip: IP,
      stakePortionMinor: STAKE / 2n,
    });

    const afterPartial = await liabilityOf(ctx, market.marketId);
    expect(afterPartial).toBe(CLAIM / 2n);

    await settleThroughPipeline(ctx, market.eventId, placed.betId, 0, 3);

    // Zero, and reached by releasing the remaining half — not by releasing the
    // whole claim a second time and being floored there by GREATEST.
    expect(await liabilityOf(ctx, market.marketId)).toBe(0n);
  }, 120_000);

  /**
   * The proof that the release above is arithmetic rather than a floor.
   *
   * A second bet from another customer holds its own claim on the same market.
   * If settlement releases the first bet's whole claim after half of it has
   * already been given back, the surplus eats into the second bet's liability
   * and the market under-reports what it still stands to lose.
   */
  it("does not consume another bet's liability on the same market", async () => {
    const ctx = context();
    const { userId, market, placed } = await pendingBet(ctx);

    const other = await createFundedUser(ctx, 1_000_000n);
    await ctx.placement.placeBet({
      userId: other.userId,
      walletId: other.walletId,
      ip: IP,
      stakeMinor: STAKE,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "4.000" }],
    });

    expect(await liabilityOf(ctx, market.marketId)).toBe(CLAIM * 2n);

    await cashOut(ctx).cashOutPartial({
      betId: placed.betId,
      userId,
      ip: IP,
      stakePortionMinor: STAKE / 2n,
    });
    await settleThroughPipeline(ctx, market.eventId, placed.betId, 0, 3);

    // The second customer's bet is untouched, so its whole claim remains.
    expect(await liabilityOf(ctx, market.marketId)).toBe(CLAIM);
  }, 120_000);

  it("releases the whole claim when partials add up to the full stake", async () => {
    const ctx = context();
    const { userId, market, placed } = await pendingBet(ctx);
    const service = cashOut(ctx);

    await service.cashOutPartial({
      betId: placed.betId,
      userId,
      ip: IP,
      stakePortionMinor: STAKE / 4n,
    });
    await service.cashOutPartial({
      betId: placed.betId,
      userId,
      ip: IP,
      stakePortionMinor: STAKE / 4n,
    });
    const last = await service.cashOutPartial({
      betId: placed.betId,
      userId,
      ip: IP,
      stakePortionMinor: STAKE / 2n,
    });

    // The final portion closes the bet, so it never reaches settlement.
    expect(last.remainingStakeMinor).toBe(0n);
    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("CASHED_OUT");

    expect(await liabilityOf(ctx, market.marketId)).toBe(0n);
  }, 120_000);

  /**
   * Thirds do not divide a claim of 300,000 evenly at every step, so this
   * pins the rounding direction: the released total may never EXCEED the
   * claim, and whatever the truncation leaves behind is given back by the
   * final release rather than stranded.
   */
  it("truncates in the book's favour and still finishes at zero", async () => {
    const ctx = context();
    const { userId, market, placed } = await pendingBet(ctx);
    const service = cashOut(ctx);

    // 33,333 of a 100,000 stake: 1/3 with a remainder, three times over.
    await service.cashOutPartial({
      betId: placed.betId,
      userId,
      ip: IP,
      stakePortionMinor: 33_333n,
    });
    const afterOne = await liabilityOf(ctx, market.marketId);

    // Never below the exact remainder — under-releasing is safe, over is not.
    expect(afterOne).toBeGreaterThanOrEqual(CLAIM - (CLAIM * 33_333n) / STAKE);
    expect(afterOne).toBeLessThan(CLAIM);

    await settleThroughPipeline(ctx, market.eventId, placed.betId, 0, 3);
    expect(await liabilityOf(ctx, market.marketId)).toBe(0n);
  }, 120_000);

  /**
   * The smallest partial the service will accept, then settlement.
   *
   * It is ₦1 rather than one kobo: one kobo of a ₦1,000 position prices to
   * zero after the margin, and the service refuses that with
   * VALUE_TOO_SMALL — correctly, since paying nothing for part of a stake
   * would be taking it. The first version of this test asked for one kobo and
   * failed on that refusal, which was the test being wrong rather than the
   * code. Recorded here so the next reader does not "fix" the service.
   */
  it("never leaves a settled market holding liability from a cashed-out bet", async () => {
    const ctx = context();
    const { userId, market, placed } = await pendingBet(ctx);

    await cashOut(ctx).cashOutPartial({
      betId: placed.betId,
      userId,
      ip: IP,
      stakePortionMinor: 100n,
    });
    await settleThroughPipeline(ctx, market.eventId, placed.betId, 3, 0);

    const [open] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM bets WHERE id = ${placed.betId}::uuid AND status = 'PENDING'
    `);
    expect(Number(open!.n)).toBe(0);
    expect(await liabilityOf(ctx, market.marketId)).toBe(0n);
  }, 120_000);
});
