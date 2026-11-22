import { getRedisClient } from "@/db/redis";
import { OutOfBudgetError } from "./budget";
import { OddsApiIoProvider } from "./odds-api-io";
import { getSportCounts } from "./odds.service";
import { ALL_SPORT_KEYS, SPORT_BY_KEY, type SportKey } from "./sports-catalog";
import { OddsSyncService, type FixtureSyncResult } from "./sync.service";

/**
 * Budget-safe multi-sport sync coordinator.
 *
 * WHY THIS EXISTS
 * ---------------
 * 1. The free-tier odds-api.io quota is 100 req/hr (86 background) and
 *    500 req/day (420 background). Running 13 sports x 4 watchlist calls every
 *    5 minutes spent 52 calls per tick, exhausting the hourly cap in 10 minutes
 *    and the daily cap in 40 minutes — starving Basketball, Tennis, Table
 *    Tennis, Esports and the other 8 sports for the rest of the day.
 * 2. On long-lived Node.js deployments (Railway) where Inngest Cloud may not
 *    yet be connected or has not fired after a fresh deploy, starting up with
 *    only football in Postgres left every other sport tab empty until an
 *    operator ran a script manually.
 *
 * DESIGN
 * ------
 * - Every sport gets its own Redis cooldown key so Inngest AND the built-in
 *   background loop share state and NEVER double-sync a sport.
 * - Watchlist size is tiered: 20 events (2 calls) for football, 10 events
 *   (1 call) for every other sport.
 * - Combined daily background spend across all 13 sports stays safely inside
 *   the 420/day background budget (~360 calls/day steady-state).
 * - On server boot, any sport in `ALL_SPORT_KEYS` with 0 active fixtures in
 *   Postgres is synced immediately (1 fixture call + 1 watchlist call each)
 *   behind a distributed Redis lock so multiple replicas never race.
 */

export const MULTI_SPORT_BOOKMAKERS = process.env.ODDS_BOOKMAKERS
  ? process.env.ODDS_BOOKMAKERS.split(",").map((b) => b.trim()).filter(Boolean)
  : ["1xbet", "Betway"];

// Steady-state daily background budget (free-tier background cap = 420/day):
// - Fixtures: 5 primary every 120m (60/day) + 8 extended every 240m (48/day) = 108/day
// - Odds: football 20 events (2 calls) every 45m (64/day)
//       + 4 primary 10 events (1 call) every 60m (96/day)
//       + 8 extended 10 events (1 call) every 120m (96/day) = 256/day
// Total steady-state = 364 calls/day (< 420/day background cap).
const FIXTURE_COOLDOWN_PRIMARY_SAFE = 120 * 60;
const FIXTURE_COOLDOWN_EXTENDED_SAFE = 240 * 60;
const ODDS_COOLDOWN_FOOTBALL_SAFE = 45 * 60;
const ODDS_COOLDOWN_PRIMARY_SAFE = 60 * 60;
const ODDS_COOLDOWN_EXTENDED_SAFE = 120 * 60;

export function watchlistLimitForSport(sport: string): number {
  return sport === "football" ? 20 : 10;
}

export function fixtureCooldownSeconds(sport: string): number {
  const tier = SPORT_BY_KEY[sport]?.tier ?? "extended";
  return tier === "primary" ? FIXTURE_COOLDOWN_PRIMARY_SAFE : FIXTURE_COOLDOWN_EXTENDED_SAFE;
}

export function oddsCooldownSeconds(sport: string): number {
  if (sport === "football") return ODDS_COOLDOWN_FOOTBALL_SAFE;
  const tier = SPORT_BY_KEY[sport]?.tier ?? "extended";
  return tier === "primary" ? ODDS_COOLDOWN_PRIMARY_SAFE : ODDS_COOLDOWN_EXTENDED_SAFE;
}

/** Pure estimate of steady-state background API calls per 24h across all 13 sports. */
export function estimatedDailyBackgroundCalls(): {
  fixtures: number;
  odds: number;
  total: number;
} {
  const daySeconds = 24 * 60 * 60;
  let fixtures = 0;
  let odds = 0;
  for (const sport of ALL_SPORT_KEYS) {
    fixtures += daySeconds / fixtureCooldownSeconds(sport);
    const oddsCallsPerSweep = Math.ceil(watchlistLimitForSport(sport) / 10);
    odds += (daySeconds / oddsCooldownSeconds(sport)) * oddsCallsPerSweep;
  }
  return {
    fixtures: Math.round(fixtures),
    odds: Math.round(odds),
    total: Math.round(fixtures + odds),
  };
}

export function createSyncServiceForSport(sport: string): OddsSyncService {
  const apiKey = process.env.ODDS_API_KEY?.trim();
  if (!apiKey) throw new Error("ODDS_API_KEY is required for odds sync");
  return new OddsSyncService(new OddsApiIoProvider(apiKey), {
    sport,
    bookmakers: MULTI_SPORT_BOOKMAKERS,
    watchlistLimit: watchlistLimitForSport(sport),
  });
}

async function claimSportSlot(kind: "fixtures" | "odds", sport: string, ttlSeconds: number): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const res = await redis.set(
      `oddssync:${kind}:v1:${sport}`,
      String(Date.now()),
      "EX",
      ttlSeconds,
      "NX",
    );
    return res === "OK";
  } catch {
    // If Redis is momentarily unreachable, allow the run so sync degrades gracefully.
    return true;
  }
}

async function releaseSportSlot(kind: "fixtures" | "odds", sport: string): Promise<void> {
  try {
    await getRedisClient().del(`oddssync:${kind}:v1:${sport}`);
  } catch {
    // Best-effort cleanup on failure so the next tick can retry.
  }
}

export async function syncSportFixturesIfDue(
  sport: string,
  opts?: { force?: boolean },
): Promise<(FixtureSyncResult & { skipped?: false }) | { skipped: true; reason: string }> {
  const ttl = fixtureCooldownSeconds(sport);
  if (!opts?.force) {
    const claimed = await claimSportSlot("fixtures", sport, ttl);
    if (!claimed) return { skipped: true, reason: "cooldown" };
  }

  try {
    const result = await createSyncServiceForSport(sport).syncFixtures();
    return { ...result, skipped: false };
  } catch (error) {
    if (!opts?.force) await releaseSportSlot("fixtures", sport);
    throw error;
  }
}

export async function syncSportOddsIfDue(
  sport: string,
  opts?: { force?: boolean },
): Promise<{ events: number; skipped?: boolean; reason?: string }> {
  const ttl = oddsCooldownSeconds(sport);
  if (!opts?.force) {
    const claimed = await claimSportSlot("odds", sport, ttl);
    if (!claimed) return { events: 0, skipped: true, reason: "cooldown" };
  }

  try {
    const result = await createSyncServiceForSport(sport).syncOddsDelta();
    return { ...result, skipped: false };
  } catch (error) {
    if (!opts?.force) await releaseSportSlot("odds", sport);
    throw error;
  }
}

async function acquireBootstrapLock(): Promise<boolean> {
  try {
    const res = await getRedisClient().set(
      "oddssync:bg:lock:v1",
      String(Date.now()),
      "EX",
      240,
      "NX",
    );
    return res === "OK";
  } catch {
    return false;
  }
}

async function releaseBootstrapLock(): Promise<void> {
  try {
    await getRedisClient().del("oddssync:bg:lock:v1");
  } catch {
    // Ignore lock cleanup errors.
  }
}

/**
 * Self-healing multi-sport sync pass for production Node.js deployments.
 *
 * 1. Inspects active counts per sport in Postgres (1 SQL query, 0 API calls).
 * 2. Immediately fills any sport with 0 active fixtures (1 fixture call +
 *    1 watchlist call each), so Basketball and all other 12 sports appear on
 *    the live site automatically right after deployment.
 * 3. For sports already present, refreshes any whose per-sport cooldown has
 *    elapsed, stopping cleanly if `OutOfBudgetError` is hit.
 */
export async function runMultiSportBackgroundPass(): Promise<{
  skipped?: boolean;
  bootstrapped: SportKey[];
  refreshedFixtures: SportKey[];
  refreshedOdds: SportKey[];
}> {
  const summary = {
    bootstrapped: [] as SportKey[],
    refreshedFixtures: [] as SportKey[],
    refreshedOdds: [] as SportKey[],
  };

  if (!process.env.ODDS_API_KEY?.trim()) {
    return { skipped: true, ...summary };
  }

  const locked = await acquireBootstrapLock();
  if (!locked) {
    return { skipped: true, ...summary };
  }

  try {
    const counts = await getSportCounts().catch(() => ({} as Record<string, { upcoming: number; live: number }>));

    // Phase A: Bootstrap any sport currently missing from Postgres FIRST.
    const missingSports = ALL_SPORT_KEYS.filter((sport) => (counts[sport]?.upcoming ?? 0) === 0);
    for (const sport of missingSports) {
      try {
        const fx = await syncSportFixturesIfDue(sport, { force: true });
        if (!fx.skipped && fx.upserted > 0) {
          await claimSportSlot("fixtures", sport, fixtureCooldownSeconds(sport));
          summary.bootstrapped.push(sport);
        }
        const odds = await syncSportOddsIfDue(sport, { force: true });
        if (!odds.skipped) {
          await claimSportSlot("odds", sport, oddsCooldownSeconds(sport));
        }
      } catch (error) {
        if (error instanceof OutOfBudgetError) {
          console.warn(`[odds-bg] budget cap reached during bootstrap at ${sport}; pausing`);
          return summary;
        }
        console.error(`[odds-bg] bootstrap failed for ${sport}`, error);
      }
    }

    // Phase B: Refresh any sport whose per-sport cooldown has elapsed.
    for (const sport of ALL_SPORT_KEYS) {
      if (missingSports.includes(sport)) continue;
      try {
        const fx = await syncSportFixturesIfDue(sport);
        if (!fx.skipped) summary.refreshedFixtures.push(sport);

        const odds = await syncSportOddsIfDue(sport);
        if (!odds.skipped) summary.refreshedOdds.push(sport);
      } catch (error) {
        if (error instanceof OutOfBudgetError) {
          console.warn(`[odds-bg] budget cap reached during refresh at ${sport}; pausing`);
          return summary;
        }
        console.error(`[odds-bg] refresh failed for ${sport}`, error);
      }
    }

    if (
      summary.bootstrapped.length > 0 ||
      summary.refreshedFixtures.length > 0 ||
      summary.refreshedOdds.length > 0
    ) {
      console.info(
        `[odds-bg] complete — bootstrapped=${summary.bootstrapped.length} (${summary.bootstrapped.join(",") || "none"}), fixtures=${summary.refreshedFixtures.length}, odds=${summary.refreshedOdds.length}`,
      );
    }

    return summary;
  } finally {
    await releaseBootstrapLock();
  }
}

declare global {
  var __plutobetOddsBgStarted: boolean | undefined;
}

/**
 * Starts the lightweight self-healing multi-sport sync loop once per Node.js
 * server process. Safe on both Railway (long-lived Node) and serverless hosts
 * (no-ops during build or tests, never throws on startup).
 */
export function startBackgroundOddsSync(): void {
  if (globalThis.__plutobetOddsBgStarted) return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.ODDS_BG_SYNC_DISABLED === "1") return;
  if (!process.env.ODDS_API_KEY?.trim()) return;
  if (!process.env.DATABASE_URL?.trim() && !process.env.POSTGRES_URL?.trim()) return;

  globalThis.__plutobetOddsBgStarted = true;

  // Give the HTTP server 12 seconds to finish startup before running bootstrap.
  const bootTimer = setTimeout(() => {
    void runMultiSportBackgroundPass().catch((error) => {
      console.error("[odds-bg] initial bootstrap pass failed", error);
    });
  }, 12_000);
  bootTimer.unref?.();

  // Periodic steady-state pass every 10 minutes (shares Redis cooldowns with Inngest).
  const intervalTimer = setInterval(() => {
    void runMultiSportBackgroundPass().catch((error) => {
      console.error("[odds-bg] periodic pass failed", error);
    });
  }, 10 * 60_000);
  intervalTimer.unref?.();
}
