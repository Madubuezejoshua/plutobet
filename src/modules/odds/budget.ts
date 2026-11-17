import type Redis from "ioredis";
import { redis as sharedRedis } from "@/db/redis";

/**
 * Free tier = 100 req/hour AND 500 req/day. Two independent caps.
 *
 * This is not optional politeness. Blowing the cap mid-Saturday means odds go
 * stale while users have live slips open, so the guard is central and no code
 * path may bypass it.
 *
 * Redis-backed because the counter must be shared across serverless
 * instances — a module-scope counter would let N instances each spend the
 * full quota.
 */

export interface BudgetLimits {
  perHour: number;
  perDay: number;
  /** Held back for user-triggered / live-critical calls. */
  reserve: number;
}

export const FREE_TIER: BudgetLimits = {
  perHour: 100,
  perDay: 500,
  reserve: 80,
};

export type CallPriority = "BACKGROUND" | "CRITICAL";

export class OutOfBudgetError extends Error {
  constructor(readonly window: "HOUR" | "DAY") {
    super(`odds provider budget exhausted for the ${window.toLowerCase()}`);
    this.name = "OutOfBudgetError";
  }
}

/**
 * Claim both windows or neither, atomically.
 *
 * The obvious implementation — INCR hour, INCR day, then check both and
 * DECR on overage — is wrong twice over. Between the INCR and the DECR a
 * concurrent caller reads an inflated count and rejects spuriously; and if
 * the day cap rejects after the hour cap allowed, the hour claim leaks unless
 * it is explicitly undone. Redis runs a Lua script atomically against the
 * whole keyspace, so the check-and-claim cannot interleave at all.
 *
 * Returns the offending window name on refusal, or "" on success.
 */
const CLAIM_SCRIPT = `
local hourKey, dayKey = KEYS[1], KEYS[2]
local cost    = tonumber(ARGV[1])
local hourCap = tonumber(ARGV[2])
local dayCap  = tonumber(ARGV[3])
local hourTtl = tonumber(ARGV[4])
local dayTtl  = tonumber(ARGV[5])

local hourUsed = tonumber(redis.call('GET', hourKey) or '0')
local dayUsed  = tonumber(redis.call('GET', dayKey)  or '0')

if hourUsed + cost > hourCap then return 'HOUR' end
if dayUsed  + cost > dayCap  then return 'DAY'  end

redis.call('INCRBY', hourKey, cost)
redis.call('INCRBY', dayKey,  cost)
-- Refresh TTLs only on first write so a long-lived window cannot be kept
-- alive indefinitely by traffic and outlive its wall-clock period.
if hourUsed == 0 then redis.call('EXPIRE', hourKey, hourTtl) end
if dayUsed  == 0 then redis.call('EXPIRE', dayKey,  dayTtl)  end
return ''
`;

function windowKeys(prefix: string, now: Date): { hour: string; day: string } {
  const iso = now.toISOString();
  return { hour: `${prefix}:h:${iso.slice(0, 13)}`, day: `${prefix}:d:${iso.slice(0, 10)}` };
}

export class ApiBudget {
  constructor(
    private readonly client: Redis = sharedRedis,
    private readonly limits: BudgetLimits = FREE_TIER,
    private readonly prefix = "oddsbudget",
  ) {}

  /**
   * Reserve `cost` requests, or throw. Throws rather than returning false —
   * a silent skip inside a poller is a bug you find three days later in the
   * odds data.
   *
   * CRITICAL may dip into the reserve; BACKGROUND pollers may not.
   */
  async spend(cost = 1, priority: CallPriority = "BACKGROUND"): Promise<void> {
    const { hour, day } = windowKeys(this.prefix, new Date());

    const hourCap =
      priority === "CRITICAL"
        ? this.limits.perHour
        : this.limits.perHour - Math.ceil(this.limits.reserve / 6);
    const dayCap =
      priority === "CRITICAL" ? this.limits.perDay : this.limits.perDay - this.limits.reserve;

    const refused = (await this.client.eval(
      CLAIM_SCRIPT,
      2,
      hour,
      day,
      String(cost),
      String(hourCap),
      String(dayCap),
      String(3_700),
      String(90_000),
    )) as string;

    if (refused === "HOUR") throw new OutOfBudgetError("HOUR");
    if (refused === "DAY") throw new OutOfBudgetError("DAY");
  }

  /** Remaining against the HARD caps, ignoring the background reserve. */
  async remaining(): Promise<{ hour: number; day: number }> {
    const { hour, day } = windowKeys(this.prefix, new Date());
    const [hourUsed, dayUsed] = await this.client.mget(hour, day);
    return {
      hour: this.limits.perHour - Number(hourUsed ?? 0),
      day: this.limits.perDay - Number(dayUsed ?? 0),
    };
  }
}

export const apiBudget = new ApiBudget();
