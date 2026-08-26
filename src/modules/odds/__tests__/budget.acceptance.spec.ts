import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { ApiBudget, OutOfBudgetError, type BudgetLimits } from "../budget";
import { OddsCadence, DEFAULT_INTERVAL_SECONDS } from "../cadence";

/**
 * Real Redis, not a mock. The guard's whole correctness argument is that the
 * check-and-claim runs atomically inside a Lua script; a fake that runs the
 * steps in JS would pass these tests while the real thing oversold the cap.
 *
 * Each test uses a unique key prefix so the wall-clock-keyed windows cannot
 * bleed between tests.
 */

const client = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

afterAll(async () => {
  await client.quit();
});

function freshBudget(limits: BudgetLimits): ApiBudget {
  return new ApiBudget(client, limits, `test:budget:${randomUUID()}`);
}

describe("odds API budget", () => {
  it("allows calls up to the background cap, then rejects", async () => {
    // reserve 6 -> background hour cap = 10 - ceil(6/6) = 9
    const budget = freshBudget({ perHour: 10, perDay: 1000, reserve: 6 });

    for (let i = 0; i < 9; i++) {
      await budget.spend(1, "BACKGROUND");
    }
    expect((await budget.remaining()).hour).toBe(1);

    await expect(budget.spend(1, "BACKGROUND")).rejects.toBeInstanceOf(OutOfBudgetError);
    // A refused call must not consume quota.
    expect((await budget.remaining()).hour).toBe(1);
  });

  it("lets CRITICAL calls into the reserve that BACKGROUND cannot touch", async () => {
    const budget = freshBudget({ perHour: 10, perDay: 1000, reserve: 6 });

    for (let i = 0; i < 9; i++) {
      await budget.spend(1, "BACKGROUND");
    }
    await expect(budget.spend(1, "BACKGROUND")).rejects.toBeInstanceOf(OutOfBudgetError);

    // Same instant, same counter — priority is the only difference.
    await expect(budget.spend(1, "CRITICAL")).resolves.toBeUndefined();
    expect((await budget.remaining()).hour).toBe(0);

    // Even CRITICAL stops at the hard cap.
    await expect(budget.spend(1, "CRITICAL")).rejects.toBeInstanceOf(OutOfBudgetError);
  });

  it("does not consume hourly quota when the day cap is the one that refuses", async () => {
    // Day is the binding constraint: background day cap = 5 - 3 = 2.
    const budget = freshBudget({ perHour: 1000, perDay: 5, reserve: 3 });

    await budget.spend(1, "BACKGROUND");
    await budget.spend(1, "BACKGROUND");
    expect((await budget.remaining()).hour).toBe(998);

    await expect(budget.spend(1, "BACKGROUND")).rejects.toBeInstanceOf(OutOfBudgetError);

    // The naive INCR-both-then-check-then-DECR implementation leaks here: the
    // hour window had room and would have been incremented before the day
    // check refused. Atomic claim means neither window moved.
    expect((await budget.remaining()).hour).toBe(998);
    expect((await budget.remaining()).day).toBe(3);
  });

  it("never oversells the cap under concurrent spenders", async () => {
    // Background hour cap = 20 - ceil(12/6) = 18.
    const budget = freshBudget({ perHour: 20, perDay: 1000, reserve: 12 });

    // 50 racing callers for 18 slots. A read-then-write counter lets several
    // observe the same pre-increment value and overshoot.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () => budget.spend(1, "BACKGROUND")),
    );

    const granted = outcomes.filter((o) => o.status === "fulfilled").length;
    const refused = outcomes.filter((o) => o.status === "rejected");

    expect(granted).toBe(18);
    expect(refused).toHaveLength(32);
    for (const outcome of refused) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(OutOfBudgetError);
    }
    // The counter must equal exactly what was granted — no phantom spend.
    expect((await budget.remaining()).hour).toBe(2);
  });

  it("charges multi-unit costs atomically", async () => {
    const budget = freshBudget({ perHour: 10, perDay: 1000, reserve: 0 });

    await budget.spend(4, "BACKGROUND");
    expect((await budget.remaining()).hour).toBe(6);

    // 7 does not fit in the remaining 6 — it must refuse outright rather than
    // partially claim.
    await expect(budget.spend(7, "BACKGROUND")).rejects.toBeInstanceOf(OutOfBudgetError);
    expect((await budget.remaining()).hour).toBe(6);
  });
});

describe("odds poller cadence", () => {
  const freshCadence = () => new OddsCadence(client, `test:cadence:${randomUUID()}`);

  it("falls back to the documented default interval", async () => {
    const cadence = freshCadence();
    expect(await cadence.getIntervalSeconds("odds-delta")).toBe(
      DEFAULT_INTERVAL_SECONDS["odds-delta"],
    );
  });

  it("claims a job at most once per interval", async () => {
    const cadence = freshCadence();
    await cadence.setIntervalSeconds("live-tick", 60);

    expect(await cadence.claimIfDue("live-tick")).toBe(true);
    // Still inside the interval — must not run again.
    expect(await cadence.claimIfDue("live-tick")).toBe(false);
  });

  it("gives the slot to exactly one of many concurrent invocations", async () => {
    const cadence = freshCadence();
    await cadence.setIntervalSeconds("fixtures", 300);

    // Every serverless instance fires on the same cron minute. Only one may win.
    const claims = await Promise.all(
      Array.from({ length: 25 }, () => cadence.claimIfDue("fixtures")),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("clamps an out-of-range interval instead of trusting it", async () => {
    const cadence = freshCadence();

    // A dashboard typo must not be able to drain the daily quota in minutes.
    await cadence.setIntervalSeconds("live-tick", 1);
    expect(await cadence.getIntervalSeconds("live-tick")).toBe(60);

    await cadence.setIntervalSeconds("fixtures", 999_999_999);
    expect(await cadence.getIntervalSeconds("fixtures")).toBe(24 * 60 * 60);
  });

  it("ignores a non-numeric configured value rather than throwing", async () => {
    const cadence = freshCadence();
    await client.set(`${(cadence as unknown as { prefix: string }).prefix}:interval:fixtures`, "soon");
    expect(await cadence.getIntervalSeconds("fixtures")).toBe(DEFAULT_INTERVAL_SECONDS.fixtures);
  });
});
