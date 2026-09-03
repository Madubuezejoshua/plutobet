import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getRedisClient } from "@/db/redis";
import { liveVersion, suspendEventMarkets } from "../live-feed";
import {
  LIVE_VERSION_TTL_MS,
  invalidateLiveVersion,
  readCachedVersion,
  resetLiveVersionFailureLog,
  writeCachedVersion,
} from "../live-version-cache";
import {
  closeBettingContexts,
  createBettingContext,
  seedMarket,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";

/**
 * The cache in front of the live board's version digest.
 *
 * WHAT IS BEING PROTECTED. The digest decides whether a polling client is told
 * "nothing changed" (304) or handed a fresh snapshot. A digest that is stale
 * for too long means a customer looking at prices that have moved — the one
 * thing a betting client must never show.
 *
 * So the tests are ordered by what actually guarantees correctness:
 *
 *   1. the TTL bounds staleness even with no invalidation at all
 *   2. explicit invalidation makes the common case immediate
 *   3. Redis being unavailable degrades to the direct query, never to an error
 *
 * The TTL is first on purpose. An invalidation-only cache is correct exactly
 * until somebody adds a write path and forgets to hook it up.
 */

const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

/** A sport nobody else's test is touching, so the cache key is ours alone. */
function uniqueSport(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLiveVersionFailureLog();
});

afterAll(async () => {
  await closeBettingContexts(contexts);
});

describe("the cached live version", () => {
  it("returns the same digest as the uncached query", async () => {
    const ctx = context();
    const sport = uniqueSport();
    await seedMarket(ctx, { prices: { home: "2.000" } });
    await ctx.database.execute(sql`UPDATE events SET sport = ${sport} WHERE sport = 'football'`);

    await invalidateLiveVersion(sport);
    const fresh = await liveVersion(sport);
    const cached = await liveVersion(sport);

    expect(cached).toBe(fresh);
    // And it really is cached, rather than recomputed to the same value.
    expect(await readCachedVersion(sport)).toBe(fresh);
  }, 120_000);

  it("serves a warm key without touching the database", async () => {
    const sport = uniqueSport();
    await writeCachedVersion(sport, "20260101000000000000-7");

    const spy = vi.spyOn(await import("@/db/pooled"), "db", "get");

    const version = await liveVersion(sport);

    expect(version).toBe("20260101000000000000-7");
    // The whole point: a hit costs no aggregate. If the getter was reached, the
    // cache is not in front of the query.
    expect(spy).not.toHaveBeenCalled();
  }, 120_000);

  it("recomputes after the key expires, so staleness is bounded without any invalidation", async () => {
    const ctx = context();
    const sport = uniqueSport();
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    await ctx.database.execute(sql`
      UPDATE events SET sport = ${sport} WHERE id = ${market.eventId}::uuid
    `);

    const before = await liveVersion(sport);

    /*
     * Change the board WITHOUT invalidating — the case a forgotten write path
     * would produce. The cache still holds the old digest for up to the TTL,
     * and must return the new one afterwards.
     */
    await ctx.database.execute(sql`
      UPDATE selections SET current_price_decimal = '3.500', updated_at = now()
      WHERE market_id = ${market.marketId}::uuid
    `);

    expect(await liveVersion(sport)).toBe(before);

    await new Promise((done) => setTimeout(done, LIVE_VERSION_TTL_MS + 250));

    expect(await liveVersion(sport)).not.toBe(before);
  }, 120_000);

  it("is dropped when an event's markets are suspended", async () => {
    const ctx = context();
    const sport = uniqueSport();
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    await ctx.database.execute(sql`
      UPDATE events SET sport = ${sport}, status = 'LIVE' WHERE id = ${market.eventId}::uuid
    `);

    const before = await liveVersion(sport);
    expect(await readCachedVersion(sport)).toBe(before);

    await suspendEventMarkets(market.eventId, "test incident");

    // Immediately, not after a TTL: a suspension is exactly the moment a client
    // must stop being told nothing changed.
    expect(await readCachedVersion(sport)).toBeNull();
    expect(await liveVersion(sport)).not.toBe(before);
  }, 120_000);

  it("collapses a burst of concurrent readers to one stored digest", async () => {
    const ctx = context();
    const sport = uniqueSport();
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    await ctx.database.execute(sql`
      UPDATE events SET sport = ${sport} WHERE id = ${market.eventId}::uuid
    `);
    await invalidateLiveVersion(sport);

    // Twenty pollers arriving together on a cold key, as a hundred viewers on
    // one match would produce.
    const versions = await Promise.all(Array.from({ length: 20 }, () => liveVersion(sport)));

    // All agree, and one value is cached. Some of them raced to compute it —
    // that is acceptable and bounded — but none may disagree about the answer.
    expect(new Set(versions).size).toBe(1);
    expect(await readCachedVersion(sport)).toBe(versions[0]);
  }, 120_000);
});

describe("when Redis is unavailable", () => {
  /*
   * Spied on the CLIENT, not on the `redis` export.
   *
   * That export is a Proxy whose `get` trap returns a bound method, so
   * `vi.spyOn(redis, "get")` fails with "get does not exist" — there is no own
   * property to replace. `getRedisClient()` hands back the real ioredis
   * singleton, which is where the methods actually live.
   */
  function failing(method: "get" | "set" | "del") {
    return vi
      .spyOn(getRedisClient(), method)
      .mockRejectedValue(new Error("connection refused") as never);
  }

  it("still answers, from the database", async () => {
    const ctx = context();
    const sport = uniqueSport();
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    await ctx.database.execute(sql`
      UPDATE events SET sport = ${sport} WHERE id = ${market.eventId}::uuid
    `);

    const expected = await liveVersion(sport);
    await invalidateLiveVersion(sport);

    failing("get");
    failing("set");

    // The live board staying up matters more than the query it saves.
    expect(await liveVersion(sport)).toBe(expected);
  }, 120_000);

  it("does not fail a suspension because a cache key could not be dropped", async () => {
    const ctx = context();
    const sport = uniqueSport();
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });
    await ctx.database.execute(sql`
      UPDATE events SET sport = ${sport}, status = 'LIVE' WHERE id = ${market.eventId}::uuid
    `);

    failing("del");

    // The suspension is the safety control; the cache is an optimisation. A
    // failure in the second must never roll back the first.
    await expect(suspendEventMarkets(market.eventId, "test incident")).resolves.toBeGreaterThan(0);

    const [row] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM markets
      WHERE event_id = ${market.eventId}::uuid AND status = 'SUSPENDED'
    `);
    expect(Number(row!.n)).toBeGreaterThan(0);
  }, 120_000);

  it("ignores a value that is not a digest", async () => {
    const sport = uniqueSport();
    // A key collision, or something else writing to this namespace. Trusting it
    // would hand a client a nonsense ETag it could never match.
    vi.spyOn(getRedisClient(), "get").mockResolvedValue("not-a-version" as never);
    expect(await readCachedVersion(sport)).toBeNull();
  }, 120_000);
});
