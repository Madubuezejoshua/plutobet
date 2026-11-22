import { oddsCadence, type OddsJob } from "@/modules/odds/cadence";
import {
  createSyncServiceForSport,
  syncSportFixturesIfDue,
  syncSportOddsIfDue,
} from "@/modules/odds/multi-sport-sync";
import { ALL_SPORT_KEYS } from "@/modules/odds/sports-catalog";
import { inngest } from "../client";

/**
 * The scheduled half of Phase 2.
 *
 * Each sport runs in its OWN `step.run(...)` so a hosted database or 60-second
 * serverless timeout on football can NEVER block Basketball, Tennis, Table
 * Tennis, Esports, or the other 8 sports from syncing.
 *
 * Per-sport Redis cooldowns and tiered watchlist limits live in
 * `multi-sport-sync.ts` so all 13 sports stay inside the 100/hr & 500/day
 * free-tier odds-api.io quota without starving any category.
 */

export const SYNC_SPORTS = ALL_SPORT_KEYS;

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
    runIfDue("fixtures", async () => {
      const results: Record<string, unknown> = {};
      for (const sport of SYNC_SPORTS) {
        results[sport] = await step.run(`fixtures-${sport}`, async () => {
          try {
            return await syncSportFixturesIfDue(sport);
          } catch (error) {
            console.error(`[odds-sync] fixtures failed for ${sport}`, error);
            return { error: error instanceof Error ? error.message : String(error) };
          }
        });
      }
      return results;
    }),
);

export const syncOddsDelta = inngest.createFunction(
  {
    id: "odds-sync-delta",
    name: "Sync odds delta",
    triggers: { cron: "* * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) =>
    runIfDue("odds-delta", async () => {
      const results: Record<string, unknown> = {};
      for (const sport of SYNC_SPORTS) {
        results[sport] = await step.run(`delta-${sport}`, async () => {
          try {
            return await syncSportOddsIfDue(sport);
          } catch (error) {
            console.error(`[odds-sync] delta failed for ${sport}`, error);
            return { error: error instanceof Error ? error.message : String(error) };
          }
        });
      }
      return results;
    }),
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
        const result = await createSyncServiceForSport("football").syncLiveOdds();
        if (result.events > 0) {
          const { invalidateLiveVersion } = await import("@/modules/odds/live-version-cache");
          await Promise.all(SYNC_SPORTS.map((sport) => invalidateLiveVersion(sport)));
        }
        return result;
      }),
    ),
);
