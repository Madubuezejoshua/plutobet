import { oddsCadence, type OddsJob } from "@/modules/odds/cadence";
import { OddsApiIoProvider } from "@/modules/odds/odds-api-io";
import { ALL_SPORT_KEYS } from "@/modules/odds/sports-catalog";
import { OddsSyncService, type SyncConfig } from "@/modules/odds/sync.service";
import { inngest } from "../client";

/**
 * The scheduled half of Phase 2. These are the only callers of the odds
 * provider in the whole system.
 *
 * Every function fires every minute and asks OddsCadence whether it is
 * actually due, rather than encoding its period in the cron expression. That
 * lets us throttle from a dashboard when we are near the API cap without a
 * redeploy — which is precisely when waiting for a deploy is unaffordable.
 *
 * concurrency.limit = 1 per function: they share one upstream quota, so
 * overlapping runs only race each other into the rate limiter.
 */

export const SYNC_SPORTS = ALL_SPORT_KEYS;

const BOOKMAKERS = process.env.ODDS_BOOKMAKERS
  ? process.env.ODDS_BOOKMAKERS.split(",").map((b) => b.trim()).filter(Boolean)
  : ["1xbet", "Betway"];

function syncService(sport = "football"): OddsSyncService {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("ODDS_API_KEY is required for odds sync");
  const config: SyncConfig = {
    sport,
    /*
     * Names are CASE-SENSITIVE and validated by the provider.
     * 1xbet covers all five synced sports (including Esports and Basketball),
     * with Betway as the second configured bookmaker.
     */
    bookmakers: BOOKMAKERS,
  };
  return new OddsSyncService(new OddsApiIoProvider(apiKey), config);
}

/**
 * The due-check is deliberately OUTSIDE step.run(): claiming the slot is not
 * idempotent (it is a one-winner SET NX), so replaying it on retry would
 * report "not due" and silently skip real work. The claim decides whether the
 * run proceeds; only the sync itself is checkpointed.
 */
async function runIfDue<T>(job: OddsJob, work: () => Promise<T>) {
  if (!(await oddsCadence.claimIfDue(job))) {
    return { skipped: true as const, reason: "not due" };
  }
  return work();
}

export const syncFixtures = inngest.createFunction(
  {
    id: "odds-sync-fixtures",
    name: "Sync fixtures",
    triggers: { cron: "* * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) =>
    runIfDue("fixtures", () =>
      step.run("fetch-and-upsert", async () => {
        const results: Record<string, unknown> = {};
        for (const sport of SYNC_SPORTS) {
          try {
            results[sport] = await syncService(sport).syncFixtures();
          } catch (error) {
            console.error(`[odds-sync] fixtures failed for ${sport}`, error);
            results[sport] = { error: error instanceof Error ? error.message : String(error) };
          }
        }
        return results;
      }),
    ),
);

export const syncOddsDelta = inngest.createFunction(
  {
    id: "odds-sync-delta",
    name: "Sync odds delta",
    triggers: { cron: "* * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) =>
    runIfDue("odds-delta", () =>
      step.run("fetch-and-persist", async () => {
        const results: Record<string, unknown> = {};
        for (const sport of SYNC_SPORTS) {
          try {
            results[sport] = await syncService(sport).syncOddsDelta();
          } catch (error) {
            console.error(`[odds-sync] delta failed for ${sport}`, error);
            results[sport] = { error: error instanceof Error ? error.message : String(error) };
          }
        }
        return results;
      }),
    ),
);

export const syncLiveOdds = inngest.createFunction(
  {
    id: "odds-sync-live",
    name: "Sync live odds",
    triggers: { cron: "* * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) =>
    runIfDue("live-tick", () =>
      step.run("fetch-and-persist", async () => {
        const result = await syncService("football").syncLiveOdds();
        if (result.events > 0) {
          const { invalidateLiveVersion } = await import("@/modules/odds/live-version-cache");
          await Promise.all(SYNC_SPORTS.map((sport) => invalidateLiveVersion(sport)));
        }
        return result;
      }),
    ),
);
