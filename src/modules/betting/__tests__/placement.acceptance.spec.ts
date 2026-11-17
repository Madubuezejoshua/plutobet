import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { markets, selections } from "@/modules/odds/schema";
import { users } from "@/modules/users/schema";
import {
  AccountNotEligibleError,
  DuplicateSelectionError,
  EventStartedError,
  ExposureLimitError,
  OddsDriftError,
  SelectionUnavailableError,
  StakeLimitError,
  UserExposureLimitError,
} from "../errors";
import { betLegs, bets, exposure } from "../schema";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "./helpers";

const context = createBettingContext();
const IP = "102.89.0.1";

async function walletBalance(ctx: BettingContext, walletId: string): Promise<bigint> {
  return ctx.wallet.getBalance(walletId);
}

async function exposureFor(ctx: BettingContext, marketId: string): Promise<bigint> {
  const rows = await ctx.database
    .select({ total: exposure.totalLiabilityMinor })
    .from(exposure)
    .where(eq(exposure.marketId, marketId));
  return rows[0]?.total ?? 0n;
}

afterAll(async () => {
  await closeBettingContexts([context]);
});

describe("bet placement", () => {
  it("places a single, debiting the stake in the same transaction as the bet", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context);

    const placed = await context.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n, // ₦1,000.00
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    expect(placed.potentialReturnMinor).toBe(200_000n);
    expect(placed.totalOddsDecimal).toBe("2.000");
    expect(await walletBalance(context, walletId)).toBe(900_000n);

    // INVARIANT 8: the bet points at the ledger transaction that funded it.
    const [row] = await context.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.stakeTxnId).toBe(placed.stakeTxnId);
    expect(row!.status).toBe("PENDING");
    expect(row!.settledAt).toBeNull();

    // Liability, not payout, is what the market carries.
    expect(await exposureFor(context, market.marketId)).toBe(100_000n);
  });

  it("prices an accumulator from the leg odds without double rounding", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const a = await seedMarket(context, { prices: { home: "2.100" } });
    const b = await seedMarket(context, { prices: { home: "1.500" } });
    const c = await seedMarket(context, { prices: { home: "3.400" } });

    const placed = await context.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [
        { selectionId: a.selectionIds.home!, odds: "2.100" },
        { selectionId: b.selectionIds.home!, odds: "1.500" },
        { selectionId: c.selectionIds.home!, odds: "3.400" },
      ],
    });

    // 2.1 * 1.5 * 3.4 = 10.71 exactly; float maths gives 10.709999999999999.
    expect(placed.totalOddsDecimal).toBe("10.710");
    expect(placed.potentialReturnMinor).toBe(1_071_000n);

    const legs = await context.database
      .select()
      .from(betLegs)
      .where(eq(betLegs.betId, placed.betId));
    expect(legs).toHaveLength(3);
    expect(legs.map((leg) => leg.lockedOddsDecimal).sort()).toEqual([
      "1.500",
      "2.100",
      "3.400",
    ]);
  });

  it("locks the odds shown, so a later price move does not change the bet", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context, { prices: { home: "2.000" } });

    const placed = await context.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    // The book moves after placement.
    await context.database
      .update(selections)
      .set({ currentPriceDecimal: "9.000" })
      .where(eq(selections.id, market.selectionIds.home!));

    const [leg] = await context.database
      .select()
      .from(betLegs)
      .where(eq(betLegs.betId, placed.betId));
    expect(leg!.lockedOddsDecimal).toBe("2.000");
  });
});

describe("bet placement rejections", () => {
  it("refuses a slip whose price moved, without touching money or exposure", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context, { prices: { home: "2.000" } });

    await expect(
      context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        // The user was shown a stale 2.500.
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.500" }],
      }),
    ).rejects.toBeInstanceOf(OddsDriftError);

    expect(await walletBalance(context, walletId)).toBe(1_000_000n);
    expect(await exposureFor(context, market.marketId)).toBe(0n);
  });

  it("accepts an improved price when the policy allows it", async () => {
    const lenient = createBettingContext({ driftPolicy: "ACCEPT_IF_BETTER" });
    try {
      const { userId, walletId } = await createFundedUser(lenient, 1_000_000n);
      const market = await seedMarket(lenient, { prices: { home: "2.500" } });

      const placed = await lenient.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      });
      // Honoured at the better live price, not the stale one.
      expect(placed.totalOddsDecimal).toBe("2.500");

      // A move against the user is still refused under the same policy.
      const worse = await seedMarket(lenient, { prices: { home: "1.500" } });
      await expect(
        lenient.placement.placeBet({
          userId,
          walletId,
          ip: IP,
          stakeMinor: 100_000n,
          idempotencyKey: slipKey(),
          legs: [{ selectionId: worse.selectionIds.home!, odds: "2.000" }],
        }),
      ).rejects.toBeInstanceOf(OddsDriftError);
    } finally {
      await closeBettingContexts([lenient]);
    }
  });

  it("refuses a bet on a suspended market", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context);
    await context.database
      .update(markets)
      .set({ status: "SUSPENDED" })
      .where(eq(markets.id, market.marketId));

    await expect(
      context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      }),
    ).rejects.toBeInstanceOf(SelectionUnavailableError);

    expect(await walletBalance(context, walletId)).toBe(1_000_000n);
  });

  // §7: a bet must never be accepted after kickoff.
  it("refuses a bet on an event that has already started", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context, {
      startsAt: new Date(Date.now() - 60_000),
    });

    await expect(
      context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      }),
    ).rejects.toBeInstanceOf(EventStartedError);

    expect(await walletBalance(context, walletId)).toBe(1_000_000n);
  });

  // §7: a self-excluded user must never place a bet.
  it("refuses a self-excluded account", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context);
    await context.database
      .update(users)
      .set({ status: "SELF_EXCLUDED" })
      .where(eq(users.id, userId));

    await expect(
      context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      }),
    ).rejects.toBeInstanceOf(AccountNotEligibleError);

    expect(await walletBalance(context, walletId)).toBe(1_000_000n);
  });

  it("refuses a stake outside the permitted range", async () => {
    const { userId, walletId } = await createFundedUser(context, 100_000_000n);
    const market = await seedMarket(context);

    await expect(
      context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 1n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      }),
    ).rejects.toBeInstanceOf(StakeLimitError);

    await expect(
      context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 99_000_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      }),
    ).rejects.toBeInstanceOf(StakeLimitError);
  });

  it("refuses the same selection twice on one slip", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context);

    await expect(
      context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        legs: [
          { selectionId: market.selectionIds.home!, odds: "2.000" },
          { selectionId: market.selectionIds.home!, odds: "2.000" },
        ],
      }),
    ).rejects.toBeInstanceOf(DuplicateSelectionError);
  });

  it("refuses a bet the user cannot fund, leaving no bet behind", async () => {
    const { userId, walletId } = await createFundedUser(context, 50_000n);
    const market = await seedMarket(context);

    await expect(
      context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      }),
    ).rejects.toThrow();

    expect(await walletBalance(context, walletId)).toBe(50_000n);
    // §7: no stake debited without a bet, and no exposure left claimed.
    expect(await exposureFor(context, market.marketId)).toBe(0n);
  });
});

describe("exposure ceiling", () => {
  it("refuses the bet that would breach the market ceiling", async () => {
    // Ceiling of ₦2,000 in liability: two ₦1,000 singles at 2.0 fit exactly.
    const capped = createBettingContext({ defaultMarketCeilingMinor: 200_000n });
    try {
      const { userId, walletId } = await createFundedUser(capped, 10_000_000n);
      const market = await seedMarket(capped, { prices: { home: "2.000" } });

      for (let i = 0; i < 2; i++) {
        await capped.placement.placeBet({
          userId,
          walletId,
          ip: IP,
          stakeMinor: 100_000n,
          idempotencyKey: slipKey(),
          legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
        });
      }
      expect(await exposureFor(capped, market.marketId)).toBe(200_000n);

      await expect(
        capped.placement.placeBet({
          userId,
          walletId,
          ip: IP,
          stakeMinor: 100_000n,
          idempotencyKey: slipKey(),
          legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
        }),
      ).rejects.toBeInstanceOf(ExposureLimitError);

      // Refused, not partially applied.
      expect(await exposureFor(capped, market.marketId)).toBe(200_000n);
    } finally {
      await closeBettingContexts([capped]);
    }
  });

  it("never lets concurrent bets jointly breach the ceiling", async () => {
    // Room for exactly 5 bets of ₦1,000 liability each.
    const contexts = Array.from({ length: 12 }, () =>
      createBettingContext({ defaultMarketCeilingMinor: 500_000n }),
    );
    try {
      const [first] = contexts;
      const { userId, walletId } = await createFundedUser(first!, 100_000_000n);
      const market = await seedMarket(first!, { prices: { home: "2.000" } });

      // Each racer uses its own connection, so these genuinely contend in the
      // database rather than queueing on one client.
      const outcomes = await Promise.allSettled(
        contexts.map((ctx) =>
          ctx.placement.placeBet({
            userId,
            walletId,
            ip: IP,
            stakeMinor: 100_000n,
            idempotencyKey: slipKey(),
            legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
          }),
        ),
      );

      const accepted = outcomes.filter((o) => o.status === "fulfilled").length;
      expect(accepted).toBe(5);
      expect(await exposureFor(first!, market.marketId)).toBe(500_000n);

      // Money moved exactly as many times as bets were accepted.
      const placedBets = await first!.database
        .select({ id: bets.id })
        .from(bets)
        .where(eq(bets.userId, userId));
      expect(placedBets).toHaveLength(5);
      expect(await walletBalance(first!, walletId)).toBe(100_000_000n - 500_000n);
    } finally {
      await closeBettingContexts(contexts);
    }
  }, 60_000);
});

describe("per-user exposure cap", () => {
  it("refuses a bet that would take the account over its open-liability cap", async () => {
    // ₦2,000 of open liability allowed. At 2.0 odds, liability == stake, so
    // two ₦1,000 bets fill it exactly.
    const capped = createBettingContext({ maxUserExposureMinor: 200_000n });
    try {
      const { userId, walletId } = await createFundedUser(capped, 10_000_000n);

      for (let i = 0; i < 2; i++) {
        const market = await seedMarket(capped, { prices: { home: "2.000" } });
        await capped.placement.placeBet({
          userId,
          walletId,
          ip: IP,
          stakeMinor: 100_000n,
          idempotencyKey: slipKey(),
          legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
        });
      }

      // A DIFFERENT market each time, so the market ceiling is nowhere near
      // breached — this is purely the account-level limit doing the work,
      // which a per-market check alone would never catch.
      const third = await seedMarket(capped, { prices: { home: "2.000" } });
      await expect(
        capped.placement.placeBet({
          userId,
          walletId,
          ip: IP,
          stakeMinor: 100_000n,
          idempotencyKey: slipKey(),
          legs: [{ selectionId: third.selectionIds.home!, odds: "2.000" }],
        }),
      ).rejects.toBeInstanceOf(UserExposureLimitError);

      // Refused cleanly: two bets, and the third moved no money.
      expect(await walletBalance(capped, walletId)).toBe(10_000_000n - 200_000n);
      const placed = await capped.database
        .select({ id: bets.id })
        .from(bets)
        .where(eq(bets.userId, userId));
      expect(placed).toHaveLength(2);
    } finally {
      await closeBettingContexts([capped]);
    }
  }, 120_000);

  it("frees the account's headroom once a bet settles", async () => {
    const capped = createBettingContext({ maxUserExposureMinor: 150_000n });
    try {
      const { userId, walletId } = await createFundedUser(capped, 10_000_000n);
      const first = await seedMarket(capped, { prices: { home: "2.000" } });
      const placed = await capped.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: first.selectionIds.home!, odds: "2.000" }],
      });

      const second = await seedMarket(capped, { prices: { home: "2.000" } });
      const request = {
        userId,
        walletId,
        ip: IP,
        stakeMinor: 100_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: second.selectionIds.home!, odds: "2.000" }],
      };
      await expect(capped.placement.placeBet(request)).rejects.toBeInstanceOf(
        UserExposureLimitError,
      );

      // Only PENDING bets hold liability — a settled bet has already paid or
      // lost, so it must stop counting against the cap.
      await capped.database
        .update(bets)
        .set({ status: "LOST", settledAt: new Date() })
        .where(eq(bets.id, placed.betId));

      const retried = await capped.placement.placeBet({ ...request, idempotencyKey: slipKey() });
      expect(retried.betId).toBeTruthy();
    } finally {
      await closeBettingContexts([capped]);
    }
  }, 120_000);

  it("never lets concurrent bets from one account jointly breach the cap", async () => {
    // Room for exactly 3 bets of ₦1,000 liability.
    const racers = Array.from({ length: 10 }, () =>
      createBettingContext({ maxUserExposureMinor: 300_000n }),
    );
    try {
      const setup = racers[0]!;
      const { userId, walletId } = await createFundedUser(setup, 50_000_000n);
      const markets = await Promise.all(
        racers.map(() => seedMarket(setup, { prices: { home: "2.000" } })),
      );

      // Each racer bets on its OWN market, so nothing collides on a market
      // ceiling — the only thing that can stop them is the account cap, and
      // it is a read-then-write unless the wallet lock serialises them.
      const outcomes = await Promise.allSettled(
        racers.map((ctx, i) =>
          ctx.placement.placeBet({
            userId,
            walletId,
            ip: IP,
            stakeMinor: 100_000n,
            idempotencyKey: slipKey(),
            legs: [{ selectionId: markets[i]!.selectionIds.home!, odds: "2.000" }],
          }),
        ),
      );

      const accepted = outcomes.filter((o) => o.status === "fulfilled").length;
      expect(accepted).toBe(3);

      const [row] = await setup.database.execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(potential_return_minor - stake_minor), 0)::text AS total
        FROM bets WHERE user_id = ${userId}::uuid AND status = 'PENDING'
      `);
      expect(BigInt(row!.total)).toBe(300_000n);
      expect(await walletBalance(setup, walletId)).toBe(50_000_000n - 300_000n);
    } finally {
      await closeBettingContexts(racers);
    }
  }, 180_000);
});

describe("placement idempotency", () => {
  it("replays a resubmitted slip instead of placing a second bet", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context);
    const key = slipKey();

    const request = {
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: key,
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    };

    const first = await context.placement.placeBet(request);

    // A double-tapped submit reuses the slip key. It must return the SAME bet
    // rather than erroring: the money was taken once and the bet exists, so a
    // failure here would tell the player their bet did not go on — and they
    // would try again.
    const replay = await context.placement.placeBet(request);
    expect(replay.betId).toBe(first.betId);
    expect(replay.stakeTxnId).toBe(first.stakeTxnId);
    expect(replay.potentialReturnMinor).toBe(first.potentialReturnMinor);

    // Money moved exactly once, and there is exactly one bet.
    expect(await walletBalance(context, walletId)).toBe(900_000n);
    const rows = await context.database
      .select({ id: bets.id })
      .from(bets)
      .where(eq(bets.stakeTxnId, first.stakeTxnId));
    expect(rows).toHaveLength(1);
  });
});

describe("bet state machine", () => {
  it("refuses to move a bet out of a terminal state", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context);
    const placed = await context.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    await context.database
      .update(bets)
      .set({ status: "WON", settledAt: new Date() })
      .where(eq(bets.id, placed.betId));

    // §7 / INVARIANT 9: a duplicate or corrected result feed must never be
    // able to re-settle a bet that already paid out.
    await expect(
      context.database
        .update(bets)
        .set({ status: "LOST" })
        .where(eq(bets.id, placed.betId)),
    ).rejects.toThrow();
  });

  it("refuses to rewrite the locked odds after placement", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context);
    const placed = await context.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    await expect(
      context.database
        .update(betLegs)
        .set({ lockedOddsDecimal: "99.000" })
        .where(eq(betLegs.betId, placed.betId)),
    ).rejects.toThrow();
  });

  it("refuses to rewrite the stake or payout after placement", async () => {
    const { userId, walletId } = await createFundedUser(context, 1_000_000n);
    const market = await seedMarket(context);
    const placed = await context.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    await expect(
      context.database
        .update(bets)
        .set({ stakeMinor: 1n })
        .where(eq(bets.id, placed.betId)),
    ).rejects.toThrow();

    await expect(
      context.database
        .update(bets)
        .set({ potentialReturnMinor: 99_999_999n })
        .where(eq(bets.id, placed.betId)),
    ).rejects.toThrow();
  });
});
