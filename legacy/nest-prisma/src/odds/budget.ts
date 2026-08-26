import type Redis from "ioredis";

/**
 * Free tier = 100 req/hour AND 500 req/day. Two independent caps.
 *
 * This is not optional politeness. Blowing the cap mid-Saturday means your
 * odds go stale while users have live slips open. Guard it centrally so no
 * future code path can bypass it.
 *
 * Redis-backed so it still holds when you run 2+ worker processes.
 */

export interface BudgetLimits {
  perHour: number;
  perDay: number;
  /** Requests held back for user-triggered / live-critical calls. */
  reserve: number;
}

export const FREE_TIER: BudgetLimits = {
  perHour: 100,
  perDay: 500,
  reserve: 80,
};

export class OutOfBudgetError extends Error {
  constructor(public readonly window: "hour" | "day") {
    super(`odds provider budget exhausted for the ${window}`);
    this.name = "OutOfBudgetError";
  }
}

export class ApiBudget {
  constructor(
    private redis: Redis,
    private limits: BudgetLimits = FREE_TIER,
    private prefix = "oddsbudget",
  ) {}

  private keys() {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hour = now.toISOString().slice(0, 13);
    return {
      hourKey: `${this.prefix}:h:${hour}`,
      dayKey: `${this.prefix}:d:${day}`,
    };
  }

  /**
   * Reserve `cost` requests. Throws rather than returning false — a silent
   * skip inside a poller is a bug you find three days later in the odds data.
   *
   * `priority: "critical"` may dip into the reserve; background pollers may not.
   */
  async spend(
    cost = 1,
    priority: "background" | "critical" = "background",
  ): Promise<void> {
    const { hourKey, dayKey } = this.keys();

    const hourCap =
      priority === "critical"
        ? this.limits.perHour
        : this.limits.perHour - Math.ceil(this.limits.reserve / 6);
    const dayCap =
      priority === "critical"
        ? this.limits.perDay
        : this.limits.perDay - this.limits.reserve;

    const [hourUsed, dayUsed] = (await this.redis
      .multi()
      .incrby(hourKey, cost)
      .incrby(dayKey, cost)
      .expire(hourKey, 3700)
      .expire(dayKey, 90000)
      .exec()
      .then((res) => [res?.[0]?.[1], res?.[1]?.[1]])) as [number, number];

    if (hourUsed > hourCap) {
      await this.redis.decrby(hourKey, cost);
      await this.redis.decrby(dayKey, cost);
      throw new OutOfBudgetError("hour");
    }
    if (dayUsed > dayCap) {
      await this.redis.decrby(hourKey, cost);
      await this.redis.decrby(dayKey, cost);
      throw new OutOfBudgetError("day");
    }
  }

  async remaining(): Promise<{ hour: number; day: number }> {
    const { hourKey, dayKey } = this.keys();
    const [h, d] = await this.redis.mget(hourKey, dayKey);
    return {
      hour: this.limits.perHour - Number(h ?? 0),
      day: this.limits.perDay - Number(d ?? 0),
    };
  }
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
