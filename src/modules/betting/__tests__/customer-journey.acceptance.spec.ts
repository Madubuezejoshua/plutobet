import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { RateLimiter } from "@/lib/api/rate-limit";
import { depositService } from "@/modules/payments/deposit.service";
import { balancesForUser } from "@/modules/wallet/lookup";
import { OtpService } from "@/modules/notifications/otp.service";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "@/modules/notifications/provider";
import { ResettlementService } from "@/modules/settlement/resettlement.service";
import { SettlementService } from "@/modules/settlement/settlement.service";
import type { MatchResult } from "@/modules/settlement/resolve";
import {
  closeBettingContexts,
  createBettingContext,
  seedMarket,
  slipKey,
  type BettingContext,
} from "./helpers";

/**
 * ONE CUSTOMER, ALL THE WAY THROUGH.
 *
 * Registration, funding, a bet, a win, a loss, a void, a correction, a
 * cash-out and a refusal — in that order, on one account, in one run, against a
 * clean disposable database.
 *
 * WHY THIS EXISTS WHEN EVERY MODULE IS ALREADY TESTED
 *
 * Seventy-five test files cover these modules in isolation and they cover them
 * well. What none of them can see is the SEAM: an account that registers
 * correctly and then cannot bet, a deposit that credits a bucket placement will
 * not spend from, exposure claimed by one module and released by another,
 * a settlement that pays into a wallet a withdrawal cannot reach. Every one of
 * those is a passing-test, broken-product failure, and every one of them lives
 * between two files that each pass.
 *
 * So the assertions here are deliberately about CONTINUITY. The balance after
 * step six must be the balance step five left behind. Nothing is re-seeded
 * between steps and nothing is written directly.
 *
 * MONEY MOVES ONLY BY THE ORDINARY ROUTES. Registration goes through the real
 * HTTP handler with a real OTP. Funding goes through `applyDepositWebhook`, the
 * same service the payment webhook calls. Placement goes through the HTTP
 * route. Settlement goes through `ingestResult` and `settleBet`. Cash-out goes
 * through its HTTP route. No balance, ledger row, bet status or exposure value
 * is written by this file — if a step cannot be reached by the paths a customer
 * and the jobs actually use, it is not tested here.
 */

const ctx: BettingContext = createBettingContext();
const settlement = new SettlementService(ctx.wallet);
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

afterAll(async () => {
  await closeBettingContexts([ctx]);
  redis.disconnect();
});

/*
 * The session is the only thing substituted, and only because a test cannot
 * hold a browser cookie. Every check behind it is real.
 */
let currentUserId: string | null = null;

vi.mock("@/modules/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/modules/auth/session")>(
    "@/modules/auth/session",
  );
  return {
    ...actual,
    requireActiveSession: async () => {
      if (!currentUserId) throw new actual.ActiveSessionRequiredError();
      return { user: { id: currentUserId } };
    },
  };
});

// ------------------------------------------------------------------ the state
//
// Carried between steps on purpose. A journey that re-creates its subject at
// each step is a suite of unit tests wearing a narrative.

const journey: {
  userId: string;
  email: string;
  phone: string;
  winBetId: string;
  lossBetId: string;
  voidBetId: string;
  cashOutBetId: string;
} = {
  userId: "",
  email: `journey-${randomUUID()}@betting.test`,
  phone: `0803${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
  winBetId: "",
  lossBetId: "",
  voidBetId: "",
  cashOutBetId: "",
};

// ------------------------------------------------------------------- helpers

/**
 * Spendable cash, read through the application's own lookup.
 *
 * Deliberately not a hand-written query. The first version of this helper was
 * `WHERE user_id = ? AND kind = 'CASH' AND currency = 'NGN'`, which is wrong
 * twice over: `kind` is USER or SYSTEM, and CASH is a **bucket**. It is the
 * exact mistake `AGENTS.md` warns about — a bucket-blind predicate matches
 * three rows and takes whichever the planner returns first, so the ledger stays
 * balanced while the money lands somewhere the customer cannot spend it.
 *
 * It failed loudly here only because the column name was also wrong. Had I
 * guessed `cached_balance_minor` correctly the query would have run, returned a
 * plausible number, and the journey would have asserted against the wrong
 * wallet. Using `balancesForUser` means this test and the product read the
 * balance the same way.
 */
async function cashMinor(userId: string): Promise<bigint> {
  return (await balancesForUser(userId)).cashMinor;
}

/** What the ledger says the account is worth, from the entries themselves. */
async function ledgerBalanceMinor(userId: string): Promise<bigint> {
  const rows = await ctx.database.execute<{ net: string }>(sql`
    SELECT COALESCE(SUM(
      CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor ELSE -le.amount_minor END
    ), 0)::text AS net
    FROM ledger_entries le
    JOIN wallets w ON w.id = le.wallet_id
    WHERE w.user_id = ${userId}::uuid
      AND w.kind = 'USER' AND w.bucket = 'CASH' AND w.currency = 'NGN'
  `);
  return BigInt(rows[0]?.net ?? "0");
}

async function betStatus(betId: string): Promise<string> {
  const rows = await ctx.database.execute<{ status: string }>(sql`
    SELECT status::text AS status FROM bets WHERE id = ${betId}::uuid
  `);
  return rows[0]?.status ?? "MISSING";
}

/** Exposure still claimed against a market. */
async function exposureMinor(marketId: string): Promise<bigint> {
  const rows = await ctx.database.execute<{ claimed: string }>(sql`
    SELECT COALESCE(SUM(b.potential_return_minor - b.stake_minor - b.released_liability_minor), 0)::text
      AS claimed
    FROM bets b
    JOIN bet_legs l ON l.bet_id = b.id
    JOIN selections s ON s.id = l.selection_id
    WHERE s.market_id = ${marketId}::uuid AND b.status = 'PENDING'
  `);
  return BigInt(rows[0]?.claimed ?? "0");
}

async function placeBet(
  userId: string | null,
  selectionId: string,
  odds: string,
  stakeMinor: bigint,
): Promise<{ status: number; body: Record<string, unknown> }> {
  currentUserId = userId;
  const { POST } = await import("@/app/api/bets/route");
  const request = new Request("http://localhost/api/bets", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "102.89.0.7" },
    body: JSON.stringify({
      stakeMinor: stakeMinor.toString(),
      legs: [{ selectionId, odds }],
      // A body field, not a header. The route's schema requires it, and a
      // slip without one is refused before any money is touched.
      idempotencyKey: slipKey(),
    }),
  });
  const response = await POST(request as never);
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function settleEvent(eventId: string, result: MatchResult): Promise<void> {
  await settlement.ingestResult({ eventId, provider: "test-provider", result });
  for (const betId of await settlement.findPendingBetIds(eventId)) {
    await settlement.settleBet(betId);
  }
}

// -------------------------------------------------------------------- the run

describe("one customer, end to end", () => {
  let winMarket: Awaited<ReturnType<typeof seedMarket>>;
  let lossMarket: Awaited<ReturnType<typeof seedMarket>>;
  let voidMarket: Awaited<ReturnType<typeof seedMarket>>;
  let cashOutMarket: Awaited<ReturnType<typeof seedMarket>>;

  beforeAll(async () => {
    winMarket = await seedMarket(ctx, { prices: { home: "2.000", draw: "3.500", away: "4.000" } });
    lossMarket = await seedMarket(ctx, { prices: { home: "2.000", draw: "3.500", away: "4.000" } });
    voidMarket = await seedMarket(ctx, { prices: { home: "2.000", draw: "3.500", away: "4.000" } });
    cashOutMarket = await seedMarket(ctx, {
      prices: { home: "2.000", draw: "3.500", away: "4.000" },
    });
  });

  // ---------------------------------------------------------------- 1. join

  it("1 — registers through the real route, with a real one-time code", async () => {
    const otp = new OtpService(
      ctx.wallet,
      new ConsoleSmsProvider(),
      new ConsoleEmailProvider(),
      new RateLimiter(redis, `journey:otp:${randomUUID()}`),
    );

    const issued = await otp.issue({
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      destination: journey.phone,
      ip: "102.89.0.7",
    });
    expect(issued.devCode, "no code was issued").toMatch(/^\d{6}$/);

    const { POST } = await import("@/app/api/auth/register/route");
    const request = new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "102.89.0.7" },
        body: JSON.stringify({
          email: journey.email,
          password: "a-long-enough-password",
          phoneNumber: journey.phone,
          otp: issued.devCode,
        dateOfBirth: "1990-06-15",
      }),
    });
    const response = await POST(request as never);

    expect(response.status, await response.text().catch(() => "")).toBeLessThan(300);

    const rows = await ctx.database.execute<{ id: string }>(sql`
      SELECT id FROM users WHERE email = ${journey.email}
    `);
    expect(rows[0]?.id, "the account was not created").toBeTruthy();
    journey.userId = rows[0]!.id;
  });

  it("2 — starts with nothing, and is refused a bet for exactly that reason", async () => {
    expect(await cashMinor(journey.userId)).toBe(0n);

    const attempt = await placeBet(journey.userId, winMarket.selectionIds.home!, "2.000", 100_000n);

    /*
     * The refusal must be ABOUT FUNDS, and say so.
     *
     * A naive "it was refused" assertion passes whatever the reason, and would
     * have hidden what this step actually found: the route answered
     * `NOTHING_PLACED` with "none of the combinations on this slip could be
     * placed" and dropped the real reason the service had already worked out.
     * A customer with an empty wallet could not tell that from a suspended
     * market. The reasons now travel with the response.
     */
    expect(attempt.status).toBe(409);
    expect(attempt.body.error).toBe("NOTHING_PLACED");

    const failures = attempt.body.details as { code: string; message: string }[] | undefined;
    expect(failures, "the response carried no reason at all").toBeTruthy();
    expect(failures![0]!.code).toBe("INSUFFICIENT_FUNDS");
    expect(failures![0]!.message).toMatch(/not enough/i);

    // And it does not leak the wallet id the domain error carries.
    expect(JSON.stringify(attempt.body)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  // -------------------------------------------------------------- 2. funding

  it("3 — is funded by the deposit path the payment webhook uses", async () => {
    const result = await depositService.applyDepositWebhook("sandbox", {
      providerRef: `journey-${randomUUID()}`,
      amountMinor: 1_000_000n, // 10,000 naira
      status: "SUCCEEDED",
      customerRef: journey.userId,
      raw: { test: "journey" },
    });

    expect(result.duplicate).toBe(false);
    expect(result.creditedTxnId, "the deposit created no ledger transaction").toBeTruthy();
    expect(await cashMinor(journey.userId)).toBe(1_000_000n);

    // The wallet and the ledger must agree. They are separate writes, and a
    // balance that drifts from its entries is the failure this product cannot
    // have.
    expect(await ledgerBalanceMinor(journey.userId)).toBe(1_000_000n);
  });

  it("4 — a replayed deposit credits nothing a second time", async () => {
    const ref = `journey-replay-${randomUUID()}`;
    const event = {
      providerRef: ref,
      amountMinor: 500_000n,
      status: "SUCCEEDED" as const,
      customerRef: journey.userId,
      raw: { test: "replay" },
    };

    await depositService.applyDepositWebhook("sandbox", event);
    const afterFirst = await cashMinor(journey.userId);

    await depositService.applyDepositWebhook("sandbox", event);
    const afterSecond = await cashMinor(journey.userId);

    expect(afterSecond, "a redelivered webhook credited twice").toBe(afterFirst);
    expect(afterFirst).toBe(1_500_000n);
  });

  // ------------------------------------------------------------- 3. a winner

  it("5 — places a bet, and the stake leaves the wallet while exposure is claimed", async () => {
    const before = await cashMinor(journey.userId);

    const placed = await placeBet(journey.userId, winMarket.selectionIds.home!, "2.000", 200_000n);
    expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
    journey.winBetId = String(placed.body.betId ?? placed.body.id ?? "");
    expect(journey.winBetId).toBeTruthy();

    expect(await cashMinor(journey.userId)).toBe(before - 200_000n);

    // Exposure is the RISK CEILING, not the stake: what we would owe beyond
    // what we hold. At 2.00 on 2,000 naira that is 2,000 naira.
    expect(await exposureMinor(winMarket.marketId)).toBe(200_000n);
  });

  it("6 — is paid on a win, once, and the exposure is released", async () => {
    const before = await cashMinor(journey.userId);

    await settleEvent(winMarket.eventId, { status: "SETTLED", periods: { ft: { home: 1, away: 0 } } });

    expect(await betStatus(journey.winBetId)).toBe("WON");
    // Stake 2,000 at 2.00 returns 4,000.
    expect(await cashMinor(journey.userId)).toBe(before + 400_000n);
    expect(await exposureMinor(winMarket.marketId)).toBe(0n);
    expect(await ledgerBalanceMinor(journey.userId)).toBe(await cashMinor(journey.userId));
  });

  it("7 — replaying the result feed pays nothing further", async () => {
    const before = await cashMinor(journey.userId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await settleEvent(winMarket.eventId, {
        status: "SETTLED",
        periods: { ft: { home: 1, away: 0 } },
      });
    }

    expect(await cashMinor(journey.userId), "a replayed result paid again").toBe(before);
  });

  // --------------------------------------------------------------- 4. a loss

  it("8 — loses a bet, keeps nothing, and still releases the exposure", async () => {
    const placed = await placeBet(journey.userId, lossMarket.selectionIds.home!, "2.000", 100_000n);
    expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
    journey.lossBetId = String(placed.body.betId ?? placed.body.id ?? "");

    const afterStake = await cashMinor(journey.userId);

    await settleEvent(lossMarket.eventId, {
      status: "SETTLED",
      periods: { ft: { home: 0, away: 2 } },
    });

    expect(await betStatus(journey.lossBetId)).toBe("LOST");
    expect(await cashMinor(journey.userId), "a lost bet returned money").toBe(afterStake);
    // The liability is gone even though nothing was paid. Exposure that
    // survives a loss silently shrinks the book's capacity for good.
    expect(await exposureMinor(lossMarket.marketId)).toBe(0n);
  });

  // ---------------------------------------------------------------- 5. a void

  it("9 — has the stake returned when the match is cancelled", async () => {
    const placed = await placeBet(journey.userId, voidMarket.selectionIds.home!, "2.000", 150_000n);
    expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
    journey.voidBetId = String(placed.body.betId ?? placed.body.id ?? "");

    const afterStake = await cashMinor(journey.userId);

    await settleEvent(voidMarket.eventId, { status: "CANCELLED", periods: {} });

    expect(await betStatus(journey.voidBetId)).toBe("VOID");
    expect(await cashMinor(journey.userId), "a void did not return the stake").toBe(
      afterStake + 150_000n,
    );
    expect(await exposureMinor(voidMarket.marketId)).toBe(0n);
  });

  // ------------------------------------------------- 5b. a corrected result

  it("9b — is paid the difference when a wrong result is corrected", async () => {
    /*
     * The provider called the loss wrong and the match is re-awarded. This is
     * the step that most needs to be in a JOURNEY rather than a module test:
     * it operates on a bet that a previous step already settled and paid, on a
     * wallet that four other steps have moved, and it has to arrive at the
     * right delta from all of that history rather than from a fixture.
     *
     * `newPayoutMinor` is the total the bet SHOULD have paid, not the
     * difference — the service derives the delta so a caller cannot get the
     * sign wrong, which is what turns a correction into a second wrong
     * payment.
     */
    const resettlement = new ResettlementService(ctx.wallet);
    const before = await cashMinor(journey.userId);

    // Staked 1,000 at 2.00, so a win pays 2,000.
    const result = await resettlement.resettle({
      betId: journey.lossBetId,
      newStatus: "WON",
      newPayoutMinor: 200_000n,
      reason: "PROVIDER_CORRECTION",
      note: "journey: the provider corrected the score after settlement",
      authorisedBy: journey.userId,
      ip: "102.89.0.7",
    });

    expect(result).toBeTruthy();
    expect(await betStatus(journey.lossBetId)).toBe("WON");
    expect(await cashMinor(journey.userId), "the correction did not pay the difference").toBe(
      before + 200_000n,
    );
    expect(await ledgerBalanceMinor(journey.userId)).toBe(await cashMinor(journey.userId));
  });

  // ------------------------------------------------------------ 6. cash-out

  it("10 — takes a cash-out through the route, and the bet closes at that figure", async () => {
    const placed = await placeBet(
      journey.userId,
      cashOutMarket.selectionIds.home!,
      "2.000",
      100_000n,
    );
    expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
    journey.cashOutBetId = String(placed.body.betId ?? placed.body.id ?? "");

    const beforeQuote = await cashMinor(journey.userId);

    currentUserId = journey.userId;
    const { GET, POST } = await import("@/app/api/bets/[id]/cashout/route");

    const quoteResponse = await GET(
      new Request(`http://localhost/api/bets/${journey.cashOutBetId}/cashout`, {
        headers: { "x-real-ip": "102.89.0.7" },
      }) as never,
    );
    const quote = (await quoteResponse.json()) as { available?: boolean; offerMinor?: string };
    expect(quoteResponse.status).toBe(200);

    // A quote must not move money. Somebody checking a price has not sold.
    expect(await cashMinor(journey.userId), "quoting moved money").toBe(beforeQuote);

    /*
     * Asserted, not tolerated.
     *
     * This began as `if (!quote.available) return`, which passed — and would
     * have gone on passing if cash-out stopped pricing anything at all. The
     * conditions here are the ones under which an offer MUST exist: a PENDING
     * bet, placed moments ago, on an OPEN market, for an ACTIVE account. If
     * this bet cannot be cashed out, no bet can, and the journey should say so
     * rather than quietly skip its most complex step.
     */
    expect(quote.available, "a fresh bet on an open market could not be priced").toBe(true);
    expect(quote.offerMinor).toMatch(/^\d+$/);

    const takeResponse = await POST(
      new Request(`http://localhost/api/bets/${journey.cashOutBetId}/cashout`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "102.89.0.7" },
        body: JSON.stringify({ expectedOfferMinor: quote.offerMinor }),
      }) as never,
    );

    expect(takeResponse.status, await takeResponse.text().catch(() => "")).toBeLessThan(300);
    expect(await betStatus(journey.cashOutBetId)).toBe("CASHED_OUT");
    expect(await cashMinor(journey.userId)).toBe(beforeQuote + BigInt(quote.offerMinor!));
    expect(await exposureMinor(cashOutMarket.marketId)).toBe(0n);
  });

  // ------------------------------------------------------------- 7. refusals

  it("11 — cannot see or touch another customer's bet", async () => {
    const stranger = await ctx.database.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO users (email, password_hash, date_of_birth)
        VALUES (${`stranger-${randomUUID()}@betting.test`}, 'test-only-not-a-hash', '1990-06-15')
        RETURNING id
      `);
      return rows[0]!.id;
    });

    currentUserId = stranger;
    const { GET } = await import("@/app/api/bets/[id]/cashout/route");
    const response = await GET(
      new Request(`http://localhost/api/bets/${journey.winBetId}/cashout`, {
        headers: { "x-real-ip": "102.89.0.9" },
      }) as never,
    );

    // Ownership is checked before anything is disclosed: what a bet is worth
    // also reveals that it exists.
    expect([403, 404]).toContain(response.status);
  });

  it("12 — refuses a signed-out visitor outright", async () => {
    const attempt = await placeBet(null, winMarket.selectionIds.home!, "2.000", 100_000n);
    expect(attempt.status).toBe(401);
  });

  // -------------------------------------------------------- 8. the invariant

  it("13 — ends with the wallet and the ledger still agreeing to the kobo", async () => {
    /*
     * The whole point of the run. Ten money movements across five modules —
     * a deposit, a replay, four stakes, a payout, a refund, a correction and a
     * cash-out —
     * and the balance is still exactly the sum of the entries behind it.
     *
     * Asserted last and against the ledger rather than a running total kept by
     * this test, because a total this file computes is a second implementation
     * of the arithmetic, and two implementations agreeing proves only that
     * they share an assumption.
     */
    const wallet = await cashMinor(journey.userId);
    const ledger = await ledgerBalanceMinor(journey.userId);

    expect(ledger, "the wallet balance has drifted from its ledger entries").toBe(wallet);
    expect(wallet).toBeGreaterThanOrEqual(0n);

    const negative = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM wallets WHERE cached_balance_minor < 0
    `);
    expect(Number(negative[0]?.n ?? 0), "a wallet went negative").toBe(0);
  });
});
