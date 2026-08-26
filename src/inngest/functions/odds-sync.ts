import { oddsCadence, type OddsJob } from "@/modules/odds/cadence";
import { OddsApiIoProvider } from "@/modules/odds/odds-api-io";
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

const config: SyncConfig = {
  sport: "football",
  // Free tier allows exactly 2, and order decides the canonical price. Correct
  // these against /bookmakers/selected (scripts/probe-odds.ts) before prod.
  bookmakers: ["bet365", "1xbet"],
};

function syncService(): OddsSyncService {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("ODDS_API_KEY is required for odds sync");
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
    runIfDue("fixtures", () => step.run("fetch-and-upsert", () => syncService().syncFixtures())),
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
      step.run("fetch-and-persist", () => syncService().syncOddsDelta()),
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
      step.run("fetch-and-persist", () => syncService().syncLiveOdds()),
    ),
);
