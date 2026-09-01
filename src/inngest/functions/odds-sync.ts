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
  /*
   * Names are CASE-SENSITIVE and validated by the provider.
   *
   * This read `"bet365"`, which the API rejects outright with "bet365 is not a
   * valid bookmaker". The real name is `"Bet365"`. Since order decides the
   * canonical price, the invalid name sat in the position every price is
   * resolved from — so once the delta call started sending a bookmaker at all,
   * it would have failed on this instead.
   *
   * Bet365 is first for a substantive reason: it publishes `ML`, the 3-way
   * match-result market that maps to `1x2`, which is the market most bets are
   * placed on. 1xbet does NOT return it — verified against both live — so a
   * 1xbet-first ordering yields a sportsbook with no match-result odds.
   *
   * The plan permits exactly two. Verify against /v3/bookmakers before editing.
   */
  bookmakers: ["Bet365", "1xbet"],
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
