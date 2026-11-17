import { afterEach, describe, expect, it } from "vitest";
import {
  describePoolConfiguration,
  directSettings,
  PoolConfigurationError,
  pooledSettings,
  poolSizeFromEnv,
} from "@/db/pool-config";
import { createDirectSqlClient } from "../db-direct";

/**
 * Connection pooling for a PERSISTENT container.
 *
 * Both runtime clients used `max: 1`, justified as "a single connection per
 * serverless instance" — correct for Vercel-style serverless, wrong for
 * Railway, which runs one container for every request. There, one connection
 * means the whole application serialises: a single slow query blocks every
 * unrelated request behind it, health check included. The development server
 * wedged repeatedly, including with the scheduler stopped, which is what ruled
 * out scheduler load and left pooling as the cause.
 *
 * The load check at the bottom is the one that matters: it proves a slow query
 * no longer blocks an unrelated fast one.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.DATABASE_POOL_MAX = ORIGINAL.DATABASE_POOL_MAX;
  process.env.DIRECT_DATABASE_POOL_MAX = ORIGINAL.DIRECT_DATABASE_POOL_MAX;
  if (ORIGINAL.DATABASE_POOL_MAX === undefined) delete process.env.DATABASE_POOL_MAX;
  if (ORIGINAL.DIRECT_DATABASE_POOL_MAX === undefined) {
    delete process.env.DIRECT_DATABASE_POOL_MAX;
  }
});

describe("pool size validation", () => {
  it("uses documented defaults when nothing is configured", () => {
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.DIRECT_DATABASE_POOL_MAX;

    // Not 1. That is the whole point of this change.
    expect(pooledSettings().max).toBe(10);
    // The money path is deliberately SMALLER: these transactions take row
    // locks, so extra concurrency buys contention rather than throughput.
    expect(directSettings().max).toBe(5);
    expect(directSettings().max).toBeLessThan(pooledSettings().max);
  });

  it("accepts a valid override", () => {
    process.env.DATABASE_POOL_MAX = "20";
    expect(pooledSettings().max).toBe(20);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-4"],
    ["fractional", "2.5"],
    ["not a number", "lots"],
    ["empty-ish", "   x"],
  ])("refuses a %s pool size", (_label, value) => {
    process.env.DATABASE_POOL_MAX = value;
    // Refused, not clamped. A deployment that asked for something impossible
    // has a misunderstanding worth surfacing at boot rather than at 3am.
    expect(() => pooledSettings()).toThrow(PoolConfigurationError);
  });

  it("refuses an excessive pool size, and says why", () => {
    process.env.DATABASE_POOL_MAX = "500";
    expect(() => pooledSettings()).toThrow(/max_connections/);
  });

  it("never echoes the offending value", () => {
    process.env.DATABASE_POOL_MAX = "not-a-number-but-secret-looking";
    try {
      pooledSettings();
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      // An environment variable can hold anything. Echoing it back is how a
      // credential ends up in a boot log.
      expect(message).not.toContain("secret-looking");
      expect(message).toContain("DATABASE_POOL_MAX");
    }
  });

  it("summarises configuration without touching a URL", () => {
    delete process.env.DATABASE_POOL_MAX;
    const summary = describePoolConfiguration();
    expect(summary).toMatch(/pooled max=10/);
    expect(summary).not.toMatch(/postgres(ql)?:\/\//);
    expect(summary).not.toMatch(/@/);
  });

  it("falls back rather than throwing for an unset variable", () => {
    delete process.env.SOME_UNSET_POOL;
    expect(poolSizeFromEnv("SOME_UNSET_POOL", 7)).toBe(7);
  });
});

describe("one slow query no longer blocks everything", () => {
  it("serves a fast query while a slow one is still running", async () => {
    const url = process.env.DIRECT_DATABASE_URL;
    expect(url).toBeTruthy();

    /*
     * THE REGRESSION TEST FOR THE RAILWAY FAULT.
     *
     * With `max: 1` the fast query cannot start until the slow one commits, so
     * it finishes AFTER it. With a real pool it overtakes. Asserting the
     * ORDER rather than a duration keeps this honest on a slow CI machine: the
     * claim is "these do not serialise", and order proves exactly that without
     * depending on how fast the hardware is.
     */
    const pooled = createDirectSqlClient(url!, { max: 4 });
    try {
      const finished: string[] = [];
      const slow = pooled`SELECT pg_sleep(1.5)`.then(() => {
        finished.push("slow");
      });
      // Started second, deliberately.
      const fast = pooled`SELECT 1`.then(() => {
        finished.push("fast");
      });

      await Promise.all([slow, fast]);
      expect(finished).toEqual(["fast", "slow"]);
    } finally {
      await pooled.end({ timeout: 5 });
    }
  });

  it("serialises when the pool is 1 — the behaviour that caused the outage", async () => {
    const url = process.env.DIRECT_DATABASE_URL;
    const single = createDirectSqlClient(url!, { max: 1 });
    try {
      const finished: string[] = [];
      const slow = single`SELECT pg_sleep(1.5)`.then(() => {
        finished.push("slow");
      });
      const fast = single`SELECT 1`.then(() => {
        finished.push("fast");
      });

      await Promise.all([slow, fast]);
      // The fast query waits for the slow one. This is not a hypothetical
      // description of the old configuration — it is the old configuration,
      // reproduced, so the test above is measuring a real difference.
      expect(finished).toEqual(["slow", "fast"]);
    } finally {
      await single.end({ timeout: 5 });
    }
  });

  it("keeps a bounded pool bounded under a burst", async () => {
    const url = process.env.DIRECT_DATABASE_URL;
    const pooled = createDirectSqlClient(url!, { max: 3 });
    try {
      // Twenty concurrent queries through a pool of three: all must complete,
      // none may error. A pool that refuses work under load is worse than one
      // that queues it.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => pooled`SELECT ${i}::int AS n`),
      );
      expect(results).toHaveLength(20);
      expect(results.map((r) => Number(r[0]!.n))).toEqual(
        Array.from({ length: 20 }, (_, i) => i),
      );
    } finally {
      await pooled.end({ timeout: 5 });
    }
  }, 60_000);
});
