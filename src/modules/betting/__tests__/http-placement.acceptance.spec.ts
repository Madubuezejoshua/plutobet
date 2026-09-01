import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  type BettingContext,
} from "./helpers";

/**
 * Bet placement through the REAL HTTP route.
 *
 * Everything here was previously proven only at the service layer, which skips
 * the parts a route adds: session resolution, Zod validation, rate limiting and
 * error mapping. A service that refuses correctly while its route answers 500
 * is still a broken product, and that exact mismatch was found once already —
 * a zero stake reached the database and surfaced as an unhandled 500 rather
 * than a validation error.
 *
 * Only the session is substituted. The route wrapper, the schema, the
 * placement service, the wallet locks and the database are all real.
 */

const ctx: BettingContext = createBettingContext();

afterAll(async () => {
  await closeBettingContexts([ctx]);
});

/**
 * ONE mock, reading a mutable current user.
 *
 * The first version re-mocked and re-imported the route for every request.
 * That silently failed: `vi.doMock` registers a mock, but an already-imported
 * module stays cached, so later calls kept the FIRST user's session and every
 * subsequent round authenticated as a customer with no balance. The test
 * reported zero successes and looked like a concurrency defect when it was a
 * test-harness defect.
 *
 * Holding the session in a variable also keeps the two concurrent requests in
 * A1 on one module instance, which is what a real server does.
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

function betRequest(body: unknown): Request {
  return new Request("http://localhost/api/bets", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "102.89.0.1" },
    body: JSON.stringify(body),
  });
}

async function post(userId: string | null, body: unknown) {
  currentUserId = userId;
  const { POST } = await import("@/app/api/bets/route");
  const response = await POST(betRequest(body) as never);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: payload };
}

async function balances(userId: string) {
  const rows = await ctx.database.execute<{ bucket: string; bal: string }>(sql`
    SELECT bucket::text, cached_balance_minor::text AS bal
    FROM wallets WHERE user_id = ${userId}::uuid ORDER BY bucket
  `);
  return Object.fromEntries(rows.map((r) => [r.bucket, BigInt(r.bal)]));
}

async function counts(userId: string) {
  const [row] = await ctx.database.execute<{ bets: number; stakes: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM bets WHERE user_id = ${userId}::uuid) AS bets,
      (SELECT count(*)::int FROM ledger_transactions t
         JOIN ledger_entries e ON e.txn_id = t.id
         JOIN wallets w ON w.id = e.wallet_id
       WHERE w.user_id = ${userId}::uuid AND t.type = 'STAKE') AS stakes
  `);
  return { bets: Number(row?.bets ?? 0), stakes: Number(row?.stakes ?? 0) };
}

async function ledgerBalanced(): Promise<boolean> {
  const [row] = await ctx.database.execute<{ d: string; c: string }>(sql`
    SELECT coalesce(sum(amount_minor) FILTER (WHERE direction='DEBIT'),0)::text AS d,
           coalesce(sum(amount_minor) FILTER (WHERE direction='CREDIT'),0)::text AS c
    FROM ledger_entries
  `);
  return row!.d === row!.c;
}

describe("A1 — concurrent placement over HTTP", () => {
  it("lets exactly ONE of two simultaneous full-balance bets succeed", async () => {
    // Exactly ₦200, and each request wants all of it.
    const { userId } = await createFundedUser(ctx, 20_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const leg = { selectionId: market.selectionIds.home!, odds: "2.000" };

    const body = (key: string) => ({
      stakeMinor: "20000",
      legs: [leg],
      idempotencyKey: key,
    });

    // Two DIFFERENT idempotency keys: this is double-spending, not a retry.
    const [first, second] = await Promise.all([
      post(userId, body(`race-a-${randomUUID()}`)),
      post(userId, body(`race-b-${randomUUID()}`)),
    ]);

    const statuses = [first.status, second.status].sort();
    const accepted = [first, second].filter((r) => r.status < 300);
    const refused = [first, second].filter((r) => r.status >= 400);

    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // A typed refusal, never a 500 — the customer must be told why.
    expect(refused[0]!.status).toBeGreaterThanOrEqual(400);
    expect(refused[0]!.status).toBeLessThan(500);
    expect(statuses[1]).toBeLessThan(500);

    const after = await balances(userId);
    expect(after.CASH).toBe(0n);
    expect(after.CASH! >= 0n).toBe(true);
    expect(after.BONUS).toBe(0n);
    expect(after.LOCKED).toBe(0n);

    const tally = await counts(userId);
    expect(tally.bets).toBe(1);
    expect(tally.stakes).toBe(1);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("holds under repetition — the outcome is not a lucky interleaving", async () => {
    // One pass could pass by chance. Money safety has to be boring.
    for (let round = 0; round < 5; round += 1) {
      const { userId } = await createFundedUser(ctx, 20_000n);
      const market = await seedMarket(ctx, { prices: { home: "2.000" } });
      const leg = { selectionId: market.selectionIds.home!, odds: "2.000" };

      const results = await Promise.all([
        post(userId, { stakeMinor: "20000", legs: [leg], idempotencyKey: `r${round}-a-${randomUUID()}` }),
        post(userId, { stakeMinor: "20000", legs: [leg], idempotencyKey: `r${round}-b-${randomUUID()}` }),
      ]);

      expect(results.filter((r) => r.status < 300), `round ${round}`).toHaveLength(1);
      const after = await balances(userId);
      expect(after.CASH, `round ${round} balance`).toBe(0n);
      expect((await counts(userId)).bets, `round ${round} bets`).toBe(1);
    }
    expect(await ledgerBalanced()).toBe(true);
  });
});

describe("A2 — closed and suspended markets", () => {
  async function setMarketStatus(marketId: string, status: "SETTLED" | "VOID" | "SUSPENDED") {
    await ctx.database.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      await tx.execute(sql`
        UPDATE markets SET status = ${status}::market_status WHERE id = ${marketId}::uuid
      `);
    });
  }

  // There is no CLOSED status in this domain. `market_status` is
  // OPEN | SUSPENDED | SETTLED | VOID, so "closed" means SETTLED or VOID —
  // a market that has resolved, and a market that was cancelled. Testing an
  // invented status would have proven nothing about the real system.
  it.each(["SETTLED", "VOID", "SUSPENDED"] as const)("refuses placement on a %s market", async (status) => {
    const { userId } = await createFundedUser(ctx, 50_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    await setMarketStatus(market.marketId, status);

    const before = await balances(userId);
    const response = await post(userId, {
      stakeMinor: "20000",
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      idempotencyKey: `closed-${status}-${randomUUID()}`,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    // Deliberate refusal, not a crash: a 500 here is indistinguishable from an
    // outage and tells the customer nothing.
    expect(response.status).toBeLessThan(500);
    expect(response.body.error).toBeTruthy();

    const after = await balances(userId);
    expect(after.CASH).toBe(before.CASH!);
    expect(await counts(userId)).toEqual({ bets: 0, stakes: 0 });
    expect(await ledgerBalanced()).toBe(true);
  });

  it("creates no exposure for a refused bet", async () => {
    const { userId } = await createFundedUser(ctx, 50_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    await setMarketStatus(market.marketId, "SUSPENDED");

    await post(userId, {
      stakeMinor: "20000",
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      idempotencyKey: `exposure-${randomUUID()}`,
    });

    const [row] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM exposure WHERE market_id = ${market.marketId}::uuid
    `);
    expect(Number(row?.n ?? 0)).toBe(0);
  });
});

describe("route-level negative cases", () => {
  it("refuses an unauthenticated placement", async () => {
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const response = await post(null, {
      stakeMinor: "20000",
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      idempotencyKey: `anon-${randomUUID()}`,
    });
    expect(response.status).toBe(401);
  });

  it.each([
    ["zero stake", "0"],
    ["stake below the minimum", "1"],
  ])("refuses %s with a 4xx, never a 500", async (_label, stake) => {
    const { userId } = await createFundedUser(ctx, 50_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    const response = await post(userId, {
      stakeMinor: stake,
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      idempotencyKey: `small-${randomUUID()}`,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await counts(userId)).toEqual({ bets: 0, stakes: 0 });
  });

  it("refuses a negative stake at the schema boundary", async () => {
    const { userId } = await createFundedUser(ctx, 50_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const response = await post(userId, {
      stakeMinor: "-20000",
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      idempotencyKey: `neg-${randomUUID()}`,
    });
    expect(response.status).toBe(422);
  });

  it("refuses a stake above the balance", async () => {
    const { userId } = await createFundedUser(ctx, 20_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const response = await post(userId, {
      stakeMinor: "50000",
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      idempotencyKey: `over-${randomUUID()}`,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect((await balances(userId)).CASH).toBe(20_000n);
  });

  it("refuses stale odds rather than accepting a price the user never saw", async () => {
    const { userId } = await createFundedUser(ctx, 50_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const response = await post(userId, {
      stakeMinor: "20000",
      legs: [{ selectionId: market.selectionIds.home!, odds: "9.000" }],
      idempotencyKey: `stale-${randomUUID()}`,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await counts(userId)).toEqual({ bets: 0, stakes: 0 });
  });

  it("replays one idempotency key to a single bet", async () => {
    const { userId } = await createFundedUser(ctx, 50_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const key = `dupe-${randomUUID()}`;
    const body = {
      stakeMinor: "20000",
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      idempotencyKey: key,
    };

    const first = await post(userId, body);
    const second = await post(userId, body);

    expect(first.status).toBeLessThan(300);
    expect(second.body.betId).toBe(first.body.betId);
    expect((await counts(userId)).bets).toBe(1);
  });

  it("conflicts when one key is reused with different parameters", async () => {
    const { userId } = await createFundedUser(ctx, 100_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    const key = `conflict-${randomUUID()}`;
    const leg = { selectionId: market.selectionIds.home!, odds: "2.000" };

    await post(userId, { stakeMinor: "20000", legs: [leg], idempotencyKey: key });
    const changed = await post(userId, { stakeMinor: "30000", legs: [leg], idempotencyKey: key });

    // Silently succeeding here would let a client change a bet after the fact.
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(changed.status).toBeLessThan(500);
    expect((await counts(userId)).bets).toBe(1);
  });

  it("debits only the CASH bucket, never BONUS or LOCKED", async () => {
    const { userId } = await createFundedUser(ctx, 50_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    await post(userId, {
      stakeMinor: "20000",
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      idempotencyKey: `bucket-${randomUUID()}`,
    });

    const after = await balances(userId);
    expect(after.CASH).toBe(30_000n);
    // The bug this guards: a lookup by (user_id, kind, currency) matches all
    // three bucket rows and takes whichever the planner returns first.
    expect(after.BONUS).toBe(0n);
    expect(after.LOCKED).toBe(0n);
  });
});
