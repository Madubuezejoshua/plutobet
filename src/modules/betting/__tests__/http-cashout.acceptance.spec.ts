import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { users } from "@/modules/users/schema";
import { bets } from "../schema";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "./helpers";

/**
 * Cash-out through the REAL HTTP route.
 *
 * The service is proven elsewhere. This covers what a route adds and a service
 * test cannot see: session resolution, path parsing, Zod validation, and the
 * mapping from each refusal reason to a status a client can act on. A service
 * that refuses correctly while its route answers 500 is still a broken product.
 *
 * Only the session is substituted. The wrapper, the schema, the cash-out
 * service, the wallet locks and the database are all real.
 */

const ctx: BettingContext = createBettingContext();

afterAll(async () => {
  await closeBettingContexts([ctx]);
});

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

const STAKE = 100_000n;

function url(betId: string): string {
  return `http://localhost/api/bets/${betId}/cashout`;
}

async function take(userId: string | null, betId: string, body?: unknown) {
  currentUserId = userId;
  const { POST } = await import("@/app/api/bets/[id]/cashout/route");
  const request = new Request(url(betId), {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "102.89.0.1" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
  const response = await POST(request as never);
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function quote(userId: string | null, betId: string) {
  currentUserId = userId;
  const { GET } = await import("@/app/api/bets/[id]/cashout/route");
  const request = new Request(url(betId), {
    headers: { "x-real-ip": "102.89.0.1" },
  });
  const response = await GET(request as never);
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function pendingBet() {
  const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
  const market = await seedMarket(ctx, { prices: { home: "4.000" } });
  const placed = await ctx.placement.placeBet({
    userId,
    walletId,
    ip: "102.89.0.1",
    stakeMinor: STAKE,
    idempotencyKey: slipKey(),
    legs: [{ selectionId: market.selectionIds.home!, odds: "4.000" }],
  });
  return { userId, walletId, market, placed };
}

async function payoutCount(walletId: string): Promise<number> {
  const [row] = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt.id = le.txn_id
    WHERE le.wallet_id = ${walletId}::uuid
      AND le.direction = 'CREDIT' AND lt.type = 'PAYOUT'
  `);
  return Number(row!.n);
}

describe("GET /api/bets/[id]/cashout", () => {
  it("prices the position for its owner", async () => {
    const { userId, placed } = await pendingBet();

    const response = await quote(userId, placed.betId);

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(true);
    // Money crosses the wire as a string; a JSON number would lose kobo.
    expect(typeof response.body.offerMinor).toBe("string");
    expect(BigInt(response.body.offerMinor as string)).toBeGreaterThan(0n);
  }, 120_000);

  it("refuses an unauthenticated caller", async () => {
    const { placed } = await pendingBet();
    const response = await quote(null, placed.betId);
    expect(response.status).toBe(401);
  }, 120_000);

  it("will not price another customer's bet", async () => {
    const { placed } = await pendingBet();
    const stranger = await createFundedUser(ctx, 0n);

    const response = await quote(stranger.userId, placed.betId);

    // 403 with the account reason, not 404: the response must not reveal
    // whether that bet id exists.
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("ACCOUNT_NOT_ELIGIBLE");
  }, 120_000);

  /**
   * A market condition is not an error.
   *
   * "This cannot be cashed out right now" is something the page states calmly.
   * Answering 4xx would make the client treat a normal, temporary situation as
   * a failure.
   */
  it("answers 200 with available:false when the bet has already settled", async () => {
    const { userId, placed } = await pendingBet();
    await take(userId, placed.betId);

    const response = await quote(userId, placed.betId);

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(false);
    expect(response.body.reason).toBe("BET_NOT_PENDING");
  }, 120_000);

  it("rejects a malformed bet id before it reaches the database", async () => {
    const { userId } = await pendingBet();
    const response = await quote(userId, "not-a-uuid");
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("INVALID_BET_ID");
  }, 120_000);
});

describe("POST /api/bets/[id]/cashout", () => {
  it("takes the whole bet when no portion is given", async () => {
    const { userId, walletId, placed } = await pendingBet();
    const before = await ctx.wallet.getBalance(walletId);

    const response = await take(userId, placed.betId);

    expect(response.status).toBe(200);
    expect(response.body.kind).toBe("FULL");
    expect(response.body.remainingStakeMinor).toBe("0");
    expect(response.body.replayed).toBe(false);

    const paid = BigInt(response.body.offerMinor as string);
    expect(await ctx.wallet.getBalance(walletId)).toBe(before + paid);
    expect(await payoutCount(walletId)).toBe(1);

    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("CASHED_OUT");
  }, 120_000);

  it("accepts an empty body as 'take everything'", async () => {
    const { userId, placed } = await pendingBet();
    const response = await take(userId, placed.betId, undefined);
    expect(response.status).toBe(200);
    expect(response.body.kind).toBe("FULL");
  }, 120_000);

  it("takes part of the stake and leaves the rest running", async () => {
    const { userId, walletId, placed } = await pendingBet();

    const response = await take(userId, placed.betId, {
      stakePortionMinor: (STAKE / 2n).toString(),
    });

    expect(response.status).toBe(200);
    expect(response.body.kind).toBe("PARTIAL");
    expect(BigInt(response.body.remainingStakeMinor as string)).toBe(STAKE / 2n);

    const [row] = await ctx.database.select().from(bets).where(eq(bets.id, placed.betId));
    expect(row!.status).toBe("PENDING");
    expect(row!.cashedOutStakeMinor).toBe(STAKE / 2n);
    expect(await payoutCount(walletId)).toBe(1);
  }, 120_000);

  it("refuses an unauthenticated caller", async () => {
    const { placed } = await pendingBet();
    const response = await take(null, placed.betId);
    expect(response.status).toBe(401);
  }, 120_000);

  it("will not cash out another customer's bet", async () => {
    const { walletId, placed } = await pendingBet();
    const stranger = await createFundedUser(ctx, 0n);

    const response = await take(stranger.userId, placed.betId);

    expect(response.status).toBe(403);
    expect(await payoutCount(walletId)).toBe(0);
  }, 120_000);

  it("refuses a suspended account with 403 and moves nothing", async () => {
    const { userId, walletId, placed } = await pendingBet();
    await ctx.database.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, userId));

    const response = await take(userId, placed.betId);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("ACCOUNT_NOT_ELIGIBLE");
    expect(await payoutCount(walletId)).toBe(0);
  }, 120_000);

  it("answers 409 rather than 500 when the bet is no longer pending", async () => {
    const { userId, placed } = await pendingBet();
    await take(userId, placed.betId);

    // A partial on a bet that is now closed: a conflict, not a server error.
    const response = await take(userId, placed.betId, {
      stakePortionMinor: (STAKE / 4n).toString(),
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("BET_NOT_PENDING");
  }, 120_000);

  it("returns the original result when the same full cash-out is retried", async () => {
    const { userId, walletId, placed } = await pendingBet();

    const first = await take(userId, placed.betId);
    const replay = await take(userId, placed.betId);

    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.offerMinor).toBe(first.body.offerMinor);
    expect(await payoutCount(walletId)).toBe(1);
  }, 120_000);

  it("refuses a portion of zero at the boundary", async () => {
    const { userId, walletId, placed } = await pendingBet();

    const response = await take(userId, placed.betId, { stakePortionMinor: "0" });

    // A form error, caught by the schema — not a database constraint surfacing
    // as a 500 the way a zero stake once did on the placement route.
    expect(response.status).toBe(422);
    expect(await payoutCount(walletId)).toBe(0);
  }, 120_000);

  it("refuses a non-integer portion", async () => {
    const { userId, placed } = await pendingBet();
    const response = await take(userId, placed.betId, { stakePortionMinor: "100.5" });
    expect(response.status).toBe(422);
  }, 120_000);

  it("refuses an unknown field rather than ignoring it", async () => {
    const { userId, placed } = await pendingBet();
    // `.strict()`: a client sending `userId` or `offerMinor` should be told it
    // is not accepted, not have it silently dropped.
    const response = await take(userId, placed.betId, { userId: "someone-else" });
    expect(response.status).toBe(422);
  }, 120_000);

  it("will not pay less than the offer the customer accepted", async () => {
    const { userId, walletId, market, placed } = await pendingBet();

    const quoted = await quote(userId, placed.betId);
    const accepted = BigInt(quoted.body.offerMinor as string);

    // The price drifts against the customer between seeing and taking.
    await ctx.database.execute(sql`
      UPDATE selections SET current_price_decimal = '8.000'
      WHERE id = ${market.selectionIds.home!}::uuid
    `);

    const response = await take(userId, placed.betId, {
      expectedOfferMinor: accepted.toString(),
    });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe("VALUE_TOO_SMALL");
    expect(await payoutCount(walletId)).toBe(0);
  }, 120_000);
});
