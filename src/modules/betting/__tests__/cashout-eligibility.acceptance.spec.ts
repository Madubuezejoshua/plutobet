import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { users } from "@/modules/users/schema";
import { CashOutService } from "../cashout.service";
import { CashOutUnavailableError } from "../cashout";
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
 * Who may cash out, what a retry returns, and what two simultaneous requests do.
 *
 * These are the three questions that decide whether cash-out can be exposed
 * over HTTP at all. The pricing is already covered elsewhere; this is about the
 * boundary.
 *
 * EVERY CHECK HERE IS ASSERTED AGAINST THE SERVICE, NOT A ROUTE. A gate that
 * lives in a route is a gate the next caller forgets, and this service is
 * reachable from a route, an admin tool, a background job and a test.
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

const STAKE = 100_000n;

function service(ctx: BettingContext) {
  return new CashOutService(ctx.wallet, { marginBasisPoints: 500, minimumOfferMinor: 1n });
}

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

async function payoutCount(ctx: BettingContext, walletId: string): Promise<number> {
  const [row] = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt.id = le.txn_id
    WHERE le.wallet_id = ${walletId}::uuid
      AND le.direction = 'CREDIT' AND lt.type = 'PAYOUT'
  `);
  return Number(row!.n);
}

describe("cash-out eligibility", () => {
  /**
   * Every non-ACTIVE status, driven through the real service.
   *
   * Cash-out is gated like placing a bet rather than like a withdrawal.
   * Withdrawal deliberately permits a self-excluded customer, because trapping
   * their money would punish them for using the protection. Cash-out is a
   * wagering decision — choosing to exit at a price — and self-exclusion exists
   * to stop those. Nothing is trapped by refusing it: the bet still settles and
   * still pays.
   */
  for (const status of ["SUSPENDED", "RESTRICTED", "SELF_EXCLUDED", "CLOSED"] as const) {
    it(`refuses a ${status} account`, async () => {
      const ctx = context();
      const { userId, walletId, placed } = await pendingBet(ctx);

      await ctx.database.update(users).set({ status }).where(eq(users.id, userId));

      const before = await ctx.wallet.getBalance(walletId);
      await expect(
        service(ctx).cashOut({ betId: placed.betId, userId, ip: IP }),
      ).rejects.toMatchObject({ reason: "ACCOUNT_NOT_ELIGIBLE" });

      // Refused means nothing moved, not "refused after paying".
      expect(await ctx.wallet.getBalance(walletId)).toBe(before);
      expect(await payoutCount(ctx, walletId)).toBe(0);
      const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
      expect(row!.status).toBe("PENDING");
    }, 120_000);
  }

  it("refuses a partial cash-out from a suspended account too", async () => {
    const ctx = context();
    const { userId, walletId, placed } = await pendingBet(ctx);

    await ctx.database.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, userId));

    await expect(
      service(ctx).cashOutPartial({
        betId: placed.betId,
        userId,
        ip: IP,
        stakePortionMinor: STAKE / 2n,
      }),
    ).rejects.toMatchObject({ reason: "ACCOUNT_NOT_ELIGIBLE" });

    expect(await payoutCount(ctx, walletId)).toBe(0);
  }, 120_000);

  it("allows an ACTIVE account", async () => {
    const ctx = context();
    const { userId, walletId, placed } = await pendingBet(ctx);

    const result = await service(ctx).cashOut({ betId: placed.betId, userId, ip: IP });

    expect(result.offerMinor).toBeGreaterThan(0n);
    expect(result.replayed).toBeUndefined();
    expect(await payoutCount(ctx, walletId)).toBe(1);
  }, 120_000);

  it("tells a stranger nothing about whose bet it is", async () => {
    const ctx = context();
    const { placed } = await pendingBet(ctx);
    const stranger = await createFundedUser(ctx, 0n);

    // The same reason and the same message a non-eligible account gets, so the
    // response cannot be used to discover which bet ids exist.
    await expect(
      service(ctx).cashOut({ betId: placed.betId, userId: stranger.userId, ip: IP }),
    ).rejects.toMatchObject({ reason: "ACCOUNT_NOT_ELIGIBLE" });
  }, 120_000);
});

describe("cash-out idempotency", () => {
  /**
   * A committed cash-out whose response was lost.
   *
   * The customer has been paid. Answering the retry with an error invites a
   * second attempt and a support ticket about money they already have, so the
   * replay returns the original outcome and says that it did.
   */
  it("returns the original result when the same cash-out is retried", async () => {
    const ctx = context();
    const { userId, walletId, placed } = await pendingBet(ctx);
    const svc = service(ctx);

    const first = await svc.cashOut({ betId: placed.betId, userId, ip: IP });
    const balanceAfterFirst = await ctx.wallet.getBalance(walletId);

    for (let attempt = 0; attempt < 3; attempt++) {
      const replay = await svc.cashOut({ betId: placed.betId, userId, ip: IP });
      expect(replay.replayed).toBe(true);
      expect(replay.offerMinor).toBe(first.offerMinor);
      expect(replay.betId).toBe(first.betId);
    }

    // Paid once, whatever the client did.
    expect(await ctx.wallet.getBalance(walletId)).toBe(balanceAfterFirst);
    expect(await payoutCount(ctx, walletId)).toBe(1);
  }, 120_000);

  it("does not let a stranger read the result by retrying", async () => {
    const ctx = context();
    const { userId, placed } = await pendingBet(ctx);
    const stranger = await createFundedUser(ctx, 0n);

    await service(ctx).cashOut({ betId: placed.betId, userId, ip: IP });

    // Ownership is checked BEFORE the replay path, so a cashed-out bet does not
    // become readable by anyone who guesses its id.
    await expect(
      service(ctx).cashOut({ betId: placed.betId, userId: stranger.userId, ip: IP }),
    ).rejects.toBeInstanceOf(CashOutUnavailableError);
  }, 120_000);
});

describe("cash-out under concurrency", () => {
  /**
   * Two full cash-outs racing.
   *
   * The bet row lock serialises them: one performs the cash-out, the other
   * finds it already taken and replays. Either way exactly one payout exists
   * and the exposure is released once.
   */
  it("pays once when two full cash-outs race", async () => {
    const ctx = context();
    const { userId, walletId, market, placed } = await pendingBet(ctx);
    const svc = service(ctx);

    const results = await Promise.allSettled([
      svc.cashOut({ betId: placed.betId, userId, ip: IP }),
      svc.cashOut({ betId: placed.betId, userId, ip: IP }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    expect(await payoutCount(ctx, walletId)).toBe(1);

    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("CASHED_OUT");

    const [liability] = await ctx.database
      .select({ total: exposure.totalLiabilityMinor })
      .from(exposure)
      .where(eq(exposure.marketId, market.marketId));
    expect(liability!.total).toBe(0n);
  }, 120_000);

  /**
   * Two partials racing for more than the stake between them.
   *
   * Each is legal alone; together they exceed what is still running. The lock
   * makes the second read the first's committed state, so the bet can never be
   * cashed out for more stake than it has.
   */
  it("cannot buy back more stake than the bet is carrying", async () => {
    const ctx = context();
    const { userId, walletId, placed } = await pendingBet(ctx);
    const svc = service(ctx);

    await Promise.allSettled([
      svc.cashOutPartial({
        betId: placed.betId,
        userId,
        ip: IP,
        stakePortionMinor: (STAKE * 3n) / 4n,
      }),
      svc.cashOutPartial({
        betId: placed.betId,
        userId,
        ip: IP,
        stakePortionMinor: (STAKE * 3n) / 4n,
      }),
    ]);

    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.cashedOutStakeMinor).toBeLessThanOrEqual(STAKE);

    // And the money paid never exceeds what the bet could have returned.
    expect(row!.cashoutValueMinor ?? 0n).toBeLessThanOrEqual(row!.potentialReturnMinor);
    expect(await payoutCount(ctx, walletId)).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
