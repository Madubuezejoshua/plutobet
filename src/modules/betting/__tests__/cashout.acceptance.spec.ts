import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { selections } from "@/modules/odds/schema";
import { CashOutService } from "../cashout.service";
import { CashOutUnavailableError, quoteCashOut, type CashOutLegState } from "../cashout";
import { bets, exposure } from "../schema";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "./helpers";

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

describe("cash-out pricing", () => {
  const noMargin = 0;

  it("returns the stake when the price has not moved", () => {
    const legs: CashOutLegState[] = [
      { result: "PENDING", lockedOddsScaled: 2000n, currentOddsScaled: 2000n },
    ];
    // stake x 2.0 / 2.0 = stake. Nothing has changed, so the position is
    // worth exactly what was paid for it.
    expect(quoteCashOut(100_000n, legs, noMargin).fairValueMinor).toBe(100_000n);
  });

  it("pays more when the selection has shortened", () => {
    // Backed at 4.0, now 2.0: twice as likely, so worth twice the stake.
    const legs: CashOutLegState[] = [
      { result: "PENDING", lockedOddsScaled: 4000n, currentOddsScaled: 2000n },
    ];
    expect(quoteCashOut(100_000n, legs, noMargin).fairValueMinor).toBe(200_000n);
  });

  it("pays less when the selection has drifted", () => {
    const legs: CashOutLegState[] = [
      { result: "PENDING", lockedOddsScaled: 2000n, currentOddsScaled: 4000n },
    ];
    expect(quoteCashOut(100_000n, legs, noMargin).fairValueMinor).toBe(50_000n);
  });

  it("treats a won leg as certain, not merely likely", () => {
    // Leg one has landed at 2.0; leg two is unchanged at 3.0. The settled leg
    // contributes its return and no further uncertainty, so the position is
    // worth 2x the stake.
    const legs: CashOutLegState[] = [
      { result: "WON", lockedOddsScaled: 2000n },
      { result: "PENDING", lockedOddsScaled: 3000n, currentOddsScaled: 3000n },
    ];
    expect(quoteCashOut(100_000n, legs, noMargin).fairValueMinor).toBe(200_000n);
  });

  it("rides a void leg at 1.000", () => {
    const legs: CashOutLegState[] = [
      { result: "VOID" },
      { result: "PENDING", lockedOddsScaled: 2000n, currentOddsScaled: 2000n },
    ];
    expect(quoteCashOut(100_000n, legs, noMargin).fairValueMinor).toBe(100_000n);
  });

  it("applies the operator margin to the fair value", () => {
    const legs: CashOutLegState[] = [
      { result: "PENDING", lockedOddsScaled: 4000n, currentOddsScaled: 2000n },
    ];
    const quote = quoteCashOut(100_000n, legs, 500); // 5%
    expect(quote.fairValueMinor).toBe(200_000n);
    expect(quote.offerMinor).toBe(190_000n);
  });

  it("refuses a bet that already contains a losing leg", () => {
    const legs: CashOutLegState[] = [
      { result: "LOST" },
      { result: "PENDING", lockedOddsScaled: 2000n, currentOddsScaled: 2000n },
    ];
    // Buying back a bet that cannot win would be handing money away.
    expect(() => quoteCashOut(100_000n, legs, 500)).toThrow(CashOutUnavailableError);
  });

  it("refuses when a leg has no current price", () => {
    const legs: CashOutLegState[] = [
      { result: "PENDING", lockedOddsScaled: 2000n, currentOddsScaled: null },
    ];
    // A suspended market cannot be valued, and guessing is how an operator
    // buys back a losing position at a premium.
    expect(() => quoteCashOut(100_000n, legs, 500)).toThrow(CashOutUnavailableError);
  });

  it("computes a multi-leg value without per-leg truncation", () => {
    const legs: CashOutLegState[] = [
      { result: "PENDING", lockedOddsScaled: 1010n, currentOddsScaled: 1010n },
      { result: "PENDING", lockedOddsScaled: 1010n, currentOddsScaled: 1010n },
      { result: "PENDING", lockedOddsScaled: 1010n, currentOddsScaled: 1010n },
    ];
    // Unchanged prices must return the stake exactly. Dividing per leg would
    // truncate three times and shave the offer.
    expect(quoteCashOut(1_000_000n, legs, noMargin).fairValueMinor).toBe(1_000_000n);
  });
});

describe("cash-out execution", () => {
  async function pendingBet(ctx: BettingContext) {
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const market = await seedMarket(ctx, { prices: { home: "4.000" } });
    const placed = await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "4.000" }],
    });
    return { userId, walletId, market, placed };
  }

  it("pays the offer, closes the bet, and releases the exposure", async () => {
    const ctx = context();
    const service = new CashOutService(ctx.wallet, {
      marginBasisPoints: 500,
      minimumOfferMinor: 1n,
    });
    const { userId, walletId, market, placed } = await pendingBet(ctx);

    // The price halves, so the position is worth twice the stake.
    await ctx.database
      .update(selections)
      .set({ currentPriceDecimal: "2.000" })
      .where(eq(selections.id, market.selectionIds.home!));

    const result = await service.cashOut({ betId: placed.betId, userId, ip: IP });

    expect(result.offerMinor).toBe(190_000n); // 200,000 less 5%
    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n + 190_000n);

    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("CASHED_OUT");
    expect(row!.cashoutValueMinor).toBe(190_000n);
    expect(row!.settledAt).not.toBeNull();

    const [liability] = await ctx.database
      .select({ total: exposure.totalLiabilityMinor })
      .from(exposure)
      .where(eq(exposure.marketId, market.marketId));
    expect(liability!.total).toBe(0n);
  }, 120_000);

  /**
   * CORRECTED, WITH THE REASON.
   *
   * This test used to assert that a second cash-out THROWS
   * `CashOutUnavailableError`. That was the behaviour, and it was wrong: a
   * cash-out that committed and then lost its response — a dropped connection,
   * a client timeout, a retried fetch — came back as an error to a customer who
   * had already been paid. That invites a second attempt and a support ticket
   * about money they already have.
   *
   * The property the old assertion was really protecting is "paid exactly
   * once", and that is asserted here and strengthened: the retry must also
   * return the ORIGINAL figure, so the caller can show the customer what they
   * received rather than guessing. `replayed` distinguishes it from a fresh
   * cash-out for logs and for tests.
   *
   * CASHED_OUT is still terminal and the database still refuses a second
   * transition; nothing about that changed. What changed is that the service no
   * longer needs the database to refuse it, because it recognises the replay
   * first.
   */
  it("pays once and returns the original result when retried", async () => {
    const ctx = context();
    const service = new CashOutService(ctx.wallet, {
      marginBasisPoints: 500,
      minimumOfferMinor: 1n,
    });
    const { userId, walletId, placed } = await pendingBet(ctx);

    const first = await service.cashOut({ betId: placed.betId, userId, ip: IP });
    const balance = await ctx.wallet.getBalance(walletId);

    for (let i = 0; i < 3; i++) {
      const replay = await service.cashOut({ betId: placed.betId, userId, ip: IP });
      expect(replay.replayed).toBe(true);
      expect(replay.offerMinor).toBe(first.offerMinor);
    }

    expect(await ctx.wallet.getBalance(walletId)).toBe(balance);
    const payouts = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.txn_id
      WHERE le.wallet_id = ${walletId}::uuid
        AND le.direction = 'CREDIT' AND lt.type = 'PAYOUT'
    `);
    expect(Number(payouts[0]!.n)).toBe(1);
    expect(first.offerMinor).toBeGreaterThan(0n);
  }, 120_000);

  it("refuses when the price moved below what the user accepted", async () => {
    const ctx = context();
    const service = new CashOutService(ctx.wallet, {
      marginBasisPoints: 500,
      minimumOfferMinor: 1n,
    });
    const { userId, walletId, market, placed } = await pendingBet(ctx);

    const quoted = await service.quote(placed.betId);

    // The selection drifts between the quote being shown and accepted.
    await ctx.database
      .update(selections)
      .set({ currentPriceDecimal: "8.000" })
      .where(eq(selections.id, market.selectionIds.home!));

    // Honouring the stale figure would let a user wait for the market to move
    // against us and then accept the old number.
    await expect(
      service.cashOut({
        betId: placed.betId,
        userId,
        ip: IP,
        expectedOfferMinor: quoted.offerMinor,
      }),
    ).rejects.toBeInstanceOf(CashOutUnavailableError);

    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n);
  }, 120_000);

  it("refuses to cash out someone else's bet", async () => {
    const ctx = context();
    const service = new CashOutService(ctx.wallet, {
      marginBasisPoints: 500,
      minimumOfferMinor: 1n,
    });
    const { placed } = await pendingBet(ctx);
    const stranger = await createFundedUser(ctx, 0n);

    await expect(
      service.cashOut({ betId: placed.betId, userId: stranger.userId, ip: IP }),
    ).rejects.toBeInstanceOf(CashOutUnavailableError);
  }, 120_000);

  it("refuses when the market is suspended", async () => {
    const ctx = context();
    const service = new CashOutService(ctx.wallet, {
      marginBasisPoints: 500,
      minimumOfferMinor: 1n,
    });
    const { userId, walletId, market, placed } = await pendingBet(ctx);

    await ctx.database
      .update(selections)
      .set({ status: "SUSPENDED" })
      .where(eq(selections.id, market.selectionIds.home!));

    await expect(
      service.cashOut({ betId: placed.betId, userId, ip: IP }),
    ).rejects.toBeInstanceOf(CashOutUnavailableError);
    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n);
  }, 120_000);
});
