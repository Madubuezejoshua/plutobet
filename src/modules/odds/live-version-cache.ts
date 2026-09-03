import { redis } from "@/db/redis";

/**
 * A short-lived cache in front of the live board's version digest.
 *
 * WHY. `/api/live` computes the version on EVERY poll so an unchanged board can
 * answer 304 without building the snapshot. That was the right shape and the
 * wrong cost: the digest is a three-table aggregate over events, markets and
 * selections, and the board polls every five seconds per viewer. A hundred
 * people watching one match is twenty aggregates a second against Postgres to
 * answer "nothing has changed" a hundred times.
 *
 * WHAT IS AND IS NOT SAFE TO CACHE HERE.
 *
 * The version is a CHANGE DETECTOR, not a price and not an authorisation. It
 * decides whether a client is told to refresh. Nothing reads it to accept a
 * bet: placement re-reads every selection under a row lock and compares against
 * the odds the customer was shown, so a stale version can never cause a bet to
 * be taken at a price the server did not verify. That separation is what makes
 * caching this defensible at all, and it must stay true — if anything ever
 * prices from this value, delete the cache rather than reasoning about it.
 *
 * THE FAILURE IT COULD CAUSE, AND THE BOUND ON IT. A stale digest means a
 * client is told "nothing changed" when something has, and shows prices a few
 * seconds old. The mitigation is two-layered and deliberately in this order:
 *
 *   1. A TTL shorter than the poll interval. This is the CORRECTNESS bound. It
 *      holds whether or not any invalidation fires, including for a write path
 *      nobody remembered to hook up.
 *   2. Explicit invalidation on the writes that matter — repricing and
 *      suspension. This is a LATENCY improvement on top, not the guarantee.
 *
 * Putting the TTL first is the point. An invalidation-only cache is correct
 * exactly until someone adds a write path and forgets, and the symptom is stale
 * odds, which is the one thing a betting client must never show.
 *
 * REDIS DOWN IS NOT AN OUTAGE. Every function here falls back to the direct
 * query and answers correctly, just more expensively. The live board staying up
 * when the cache is unavailable matters more than the query it saves.
 */

/**
 * Two seconds.
 *
 * The board polls every five, so a viewer sees at most one extra poll's worth
 * of staleness — and in the common case none, because a reprice invalidates the
 * key. Short enough that the bound is uninteresting; long enough that a burst
 * of concurrent pollers collapses to a single aggregate.
 */
const TTL_MS = 2_000;

function keyFor(sportKey: string): string {
  return `live:version:${sportKey}`;
}

/**
 * Logged once per process rather than per request.
 *
 * A Redis outage during a busy period would otherwise write one line per poll
 * per viewer, which buries the cause in its own symptom.
 */
let failureReported = false;

function reportOnce(operation: string, error: unknown): void {
  if (failureReported) return;
  failureReported = true;
  const reason = error instanceof Error ? error.message : String(error);
  console.error(
    `[live-version] redis ${operation} failed; falling back to the direct query. ${reason}`,
  );
}

/**
 * The cached digest, or null when there is nothing usable.
 *
 * Null covers a miss, a malformed value and Redis being unreachable. The caller
 * treats all three the same way — compute it — because there is no useful
 * difference between "not cached" and "cache unavailable" at the call site.
 */
export async function readCachedVersion(sportKey: string): Promise<string | null> {
  try {
    const cached = await redis.get(keyFor(sportKey));
    // A digest is `<timestamp>-<count>`. Anything else is a key collision or a
    // value written by something that is not this module.
    return typeof cached === "string" && /^[\w]+-\d+$/.test(cached) ? cached : null;
  } catch (error) {
    reportOnce("get", error);
    return null;
  }
}

/** Stores a freshly computed digest. Never throws. */
export async function writeCachedVersion(sportKey: string, version: string): Promise<void> {
  try {
    await redis.set(keyFor(sportKey), version, "PX", TTL_MS);
  } catch (error) {
    reportOnce("set", error);
  }
}

/**
 * Drops the cached digest for a sport.
 *
 * Called after a write that changes what the board shows: repricing, and
 * suspending an event's markets. Deleting rather than overwriting keeps this
 * caller out of the business of computing a digest — the next reader does that,
 * once, and stores it.
 *
 * Never throws. A failed invalidation costs at most `TTL_MS` of staleness,
 * which is the bound the TTL exists to provide, so a Redis problem here must
 * not fail the write that triggered it.
 */
export async function invalidateLiveVersion(sportKey: string): Promise<void> {
  try {
    await redis.del(keyFor(sportKey));
  } catch (error) {
    reportOnce("del", error);
  }
}

/** Test seam: forget that a failure was reported. */
export function resetLiveVersionFailureLog(): void {
  failureReported = false;
}

export const LIVE_VERSION_TTL_MS = TTL_MS;
