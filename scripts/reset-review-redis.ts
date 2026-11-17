/**
 * Clears the review server's Redis, between runs of the browser suite.
 *
 *   npx tsx scripts/reset-review-redis.ts
 *
 * WHY THIS IS NEEDED, AND WHY IT IS NOT A WEAKENED CONTROL.
 *
 * The one-time-code service throttles by DESTINATION (3 per 15 minutes) and by
 * IP (20 per hour). Those are real controls: the first stops one number being
 * bombarded and the bill that comes with it, the second stops one actor
 * enumerating many. Every browser test that registers an account or resets a
 * password spends from the same per-IP budget, because every one of them
 * arrives from 127.0.0.1.
 *
 * A single run of the suite fits inside the hourly budget. TWO runs inside the
 * same hour — which is exactly what "run the gates twice" asks for — do not, and
 * the second run would fail on a control behaving correctly.
 *
 * The wrong fix is to raise the limit for tests. That deletes the control from
 * the only place it is ever exercised. The right one is to give the second run
 * the same clean environment the first one had: the disposable database is
 * recreated between runs, and this does the same for the disposable Redis. A
 * budget consumed by a previous run is state, not evidence.
 *
 * REFUSES ANYTHING BUT A LOOPBACK REDIS. It calls FLUSHALL, which is
 * irreversible, and the difference between a disposable local instance and a
 * production one is a single environment variable.
 *
 * IT DOES NOT LOAD `.env`, DELIBERATELY. Every other script in this repository
 * starts with `import "dotenv/config"`, and in this checkout that file holds
 * PRODUCTION credentials — including an Upstash cache. A destructive command
 * has no business reading it: the only value this needs is a loopback URL, and
 * defaulting to one means the dangerous configuration is not merely refused but
 * unreachable. Pass `REDIS_URL` explicitly to point it anywhere else, and the
 * loopback check below will still have the last word.
 */
import Redis from "ioredis";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

async function main(): Promise<void> {
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("REDIS_URL is not a URL. Refusing to flush anything.");
    process.exit(1);
  }
  if (!LOOPBACK.has(host)) {
    // The host is named because that is the whole point of the message, and a
    // hostname is not a credential. Nothing else from the URL is printed.
    console.error(
      `REDIS_URL points at "${host}", which is not this machine.\n` +
        "This calls FLUSHALL. Refusing to run.",
    );
    process.exit(1);
  }
  if (process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error(
      "UPSTASH_REDIS_REST_* is configured in this environment, which means a production\n" +
        "cache is reachable from here. Refusing to run.",
    );
    process.exit(1);
  }

  const redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    const before = await redis.dbsize();
    await redis.flushall();
    console.log(`flushed the local review Redis — ${before} key(s) removed`);
  } finally {
    redis.disconnect();
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("reset-review-redis failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
