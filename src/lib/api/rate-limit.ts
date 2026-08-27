import type Redis from "ioredis";
import { redis as sharedRedis } from "@/db/redis";

/**
 * Per-user and per-IP request limiting (§8).
 *
 * Redis-backed, not in-process: on serverless every instance would keep its
 * own counter and N instances would each allow the full quota — the same
 * reason the odds budget lives there.
 *
 * Fixed windows rather than a sliding log: a sliding window needs a sorted
 * set per key and trims on every call, which costs more than it is worth for
 * abuse control. The known cost is burstiness at a window boundary, which is
 * acceptable here and is NOT acceptable for the odds budget — that one guards
 * a hard external quota, so it stays exact.
 */

const CONSUME = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local used = redis.call('INCR', key)
if used == 1 then redis.call('EXPIRE', key, ttl) end
if used > limit then return -1 end
return limit - used
`;

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitOutcome {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  constructor(
    private readonly client: Redis = sharedRedis,
    private readonly prefix = "ratelimit",
  ) {}

  async consume(bucket: string, identity: string, rule: RateLimitRule): Promise<RateLimitOutcome> {
    const window = Math.floor(Date.now() / (rule.windowSeconds * 1000));
    const key = `${this.prefix}:${bucket}:${identity}:${window}`;

    const remaining = (await this.client.eval(
      CONSUME,
      1,
      key,
      String(rule.limit),
      String(rule.windowSeconds),
    )) as number;

    return {
      allowed: remaining >= 0,
      remaining: Math.max(remaining, 0),
      retryAfterSeconds: rule.windowSeconds,
    };
  }
}

export const rateLimiter = new RateLimiter();

/**
 * Defaults per route class.
 *
 * Placement is deliberately tighter than browsing: it is the expensive path
 * and the one worth scripting against. Webhooks are generous because the
 * caller is a payment provider retrying in good faith — throttling them
 * causes the duplicate deliveries we then have to de-duplicate anyway.
 */
export const RATE_RULES = {
  browse: { limit: 120, windowSeconds: 60 },
  placeBet: { limit: 30, windowSeconds: 60 },
  wallet: { limit: 60, windowSeconds: 60 },
  withdrawal: { limit: 10, windowSeconds: 60 },
  webhook: { limit: 600, windowSeconds: 60 },
  // Tight, and by IP: both endpoints are public and pre-account. Issuing a
  // code costs money in SMS fees, and registration is the surface a bot uses
  // to mass-create accounts for bonus abuse.
  otp: { limit: 10, windowSeconds: 60 * 15 },
  register: { limit: 5, windowSeconds: 60 * 15 },
  // Identity submission and document upload: infrequent by nature, tight
  // enough to blunt scripted probing of the uniqueness/exclusion checks.
  kyc: { limit: 8, windowSeconds: 60 * 15 },
  admin: { limit: 60, windowSeconds: 60 },
  // Password change and reset reuse the `otp` budget: both verify a secret,
  // which makes either one an oracle for guessing it if called freely.
} as const satisfies Record<string, RateLimitRule>;
