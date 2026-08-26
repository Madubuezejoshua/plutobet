import type Redis from "ioredis";
import { redis as sharedRedis } from "@/db/redis";

/**
 * Runtime-adjustable poller cadence.
 *
 * The Inngest crons all fire every minute; each handler asks this whether it
 * is actually due. That indirection exists so we can throttle from a
 * dashboard when we're near the API cap — changing a cron expression needs a
 * redeploy, and "we're burning quota right now" is exactly when you cannot
 * afford to wait for one.
 *
 * A due-check both reads AND claims the slot: two concurrent invocations of
 * the same job must not both decide they are due. SET NX with a TTL is that
 * claim, and it is atomic.
 */

export type OddsJob = "fixtures" | "odds-delta" | "live-tick" | "results";

/** Falls back to these when nothing is configured in Redis. */
export const DEFAULT_INTERVAL_SECONDS: Record<OddsJob, number> = {
  fixtures: 30 * 60,
  "odds-delta": 5 * 60,
  "live-tick": 60,
  // Results are checked less often than odds move: a match that finished
  // two minutes ago can wait, and each poll costs one provider call per event.
  results: 5 * 60,
};

const MIN_INTERVAL_SECONDS = 60; // the cron tick itself — faster is meaningless
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

export class OddsCadence {
  constructor(
    private readonly client: Redis = sharedRedis,
    private readonly prefix = "oddscadence",
  ) {}

  private intervalKey(job: OddsJob) {
    return `${this.prefix}:interval:${job}`;
  }

  private claimKey(job: OddsJob) {
    return `${this.prefix}:claim:${job}`;
  }

  async getIntervalSeconds(job: OddsJob): Promise<number> {
    const raw = await this.client.get(this.intervalKey(job));
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed)) return DEFAULT_INTERVAL_SECONDS[job];
    // Clamp rather than trust: a bad dashboard value must not be able to set a
    // 1-second interval and drain the daily quota in minutes.
    return Math.min(Math.max(Math.trunc(parsed), MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
  }

  async setIntervalSeconds(job: OddsJob, seconds: number): Promise<void> {
    const clamped = Math.min(
      Math.max(Math.trunc(seconds), MIN_INTERVAL_SECONDS),
      MAX_INTERVAL_SECONDS,
    );
    await this.client.set(this.intervalKey(job), String(clamped));
  }

  /**
   * True at most once per configured interval, across all instances.
   *
   * The TTL on the claim key IS the interval: while it exists the job is not
   * due again. Using SET NX means the winner is decided by Redis, not by a
   * read-then-write race between two concurrent invocations.
   */
  async claimIfDue(job: OddsJob): Promise<boolean> {
    const interval = await this.getIntervalSeconds(job);
    const claimed = await this.client.set(this.claimKey(job), Date.now().toString(), "EX", interval, "NX");
    return claimed === "OK";
  }
}

export const oddsCadence = new OddsCadence();
