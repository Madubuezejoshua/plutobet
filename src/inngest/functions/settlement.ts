import * as Sentry from "@sentry/nextjs";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { oddsCadence } from "@/modules/odds/cadence";
import { OddsApiIoProvider } from "@/modules/odds/odds-api-io";
import { heartbeatService } from "@/modules/reporting/heartbeat.service";
import { ResultIngestionService } from "@/modules/settlement/ingestion.service";
import { settlementService } from "@/modules/settlement/settlement.service";
import { UnsettleableError } from "@/modules/settlement/resolve";
import { inngest } from "../client";

/**
 * Settlement fan-out.
 *
 * One event per finished match, then one step.run() per bet. Each step is
 * checkpointed and retried independently, which is only safe because
 * settleBet is idempotent: it reads the bet under FOR UPDATE, returns early
 * if terminal, and keys its payout credit off the bet id.
 */

/**
 * The trigger for everything below.
 *
 * Without this, ingestResult and settleEvent are only ever reachable from a
 * test: nothing in production would notice a match had finished, and bets
 * would sit PENDING indefinitely.
 *
 * Runs every minute and asks OddsCadence whether it is due, matching the odds
 * pollers — so it can be throttled from a dashboard when API budget is tight
 * without a redeploy.
 */
export const pollMatchResults = inngest.createFunction(
  {
    id: "settlement-poll-results",
    name: "Poll finished matches",
    triggers: { cron: "* * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    if (!(await oddsCadence.claimIfDue("results"))) {
      return { skipped: true as const, reason: "not due" };
    }

    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) throw new NonRetriableError("ODDS_API_KEY is required to poll results");

    /*
     * Wrapped in a heartbeat so a job that stops running is VISIBLE.
     *
     * This poller had never executed once in the life of the project and
     * nothing anywhere could say so. A bet on a finished match simply sat
     * PENDING, and the first signal was going to be a customer asking where
     * their winnings were.
     *
     * The counts are recorded even when zero: "ran and found nothing" and
     * "did not run" are indistinguishable from the outside otherwise, and
     * only one of them needs somebody woken up.
     */
    const finished = await step.run("ingest-results", () =>
      heartbeatService.track("results", async () => {
        const events = await new ResultIngestionService(
          new OddsApiIoProvider(apiKey),
        ).pollFinishedEvents();
        return { processed: events.length, settled: 0, events };
      }),
    ).then((outcome) => outcome.events);

    if (finished.length > 0) {
      await step.sendEvent(
        "dispatch-finished-events",
        finished.map((item) => ({
          // Stable id: re-polling the same event will not fan out twice.
          id: `settle-event:${item.eventId}`,
          name: "settlement/event.finished",
          data: { eventId: item.eventId, cancelled: item.cancelled },
        })),
      );
    }

    return { ingested: finished.length };
  },
);

const eventSettledSchema = z.object({
  eventId: z.string().uuid(),
  cancelled: z.boolean().default(false),
});

const betSettlementSchema = z.object({ betId: z.string().uuid() });

const DISPATCH_BATCH = 100;

export const settleEvent = inngest.createFunction(
  {
    id: "settle-event",
    name: "Settle one event",
    triggers: { event: "settlement/event.finished" },
    // Serialised per event so two deliveries of the same result cannot both
    // fan out over the same bets at once. Bet-level idempotency would still
    // hold, but this keeps the retry history readable.
    concurrency: { limit: 5 },
  },
  async ({ event, step, runId }) => {
    const payload = eventSettledSchema.safeParse(event.data);
    if (!payload.success) {
      // Retrying a malformed event can never make it valid.
      throw new NonRetriableError("invalid settlement event payload");
    }
    const { eventId, cancelled } = payload.data;

    const betIds = await step.run("find-pending-bets", () =>
      settlementService.findPendingBetIds(eventId),
    );

    for (let offset = 0; offset < betIds.length; offset += DISPATCH_BATCH) {
      const batch = betIds.slice(offset, offset + DISPATCH_BATCH);
      await step.sendEvent(
        `dispatch-bets-${offset / DISPATCH_BATCH}`,
        batch.map((betId) => ({
          // Stable id: a replayed feed produces the same event ids, so
          // Inngest deduplicates the fan-out rather than re-running it.
          id: `settle-bet:${eventId}:${betId}`,
          name: "settlement/bet.requested",
          data: { betId },
        })),
      );
    }

    // Markets close only after the bets are dispatched, so a bet can never be
    // stranded on a market nobody will settle.
    await step.run("close-markets", () =>
      settlementService.closeEventMarkets(eventId, cancelled),
    );

    return { dispatched: betIds.length, runId };
  },
);

export const settleBet = inngest.createFunction(
  {
    id: "settle-bet",
    name: "Settle one bet",
    triggers: { event: "settlement/bet.requested" },
    concurrency: { limit: 10 },
  },
  async ({ event, step }) => {
    const payload = betSettlementSchema.safeParse(event.data);
    if (!payload.success) throw new NonRetriableError("invalid bet settlement payload");

    const result = await step.run("settle", async () => {
      try {
        const outcome = await settlementService.settleBet(payload.data.betId);
        return { ...outcome, payoutMinor: outcome.payoutMinor.toString() };
      } catch (error) {
        if (error instanceof UnsettleableError) {
          // We do not know the answer, and retrying will not teach us. Leave
          // the bet PENDING and raise it for a human — paying out on a guess
          // is the one outcome worse than settling late.
          Sentry.captureException(error, {
            level: "error",
            tags: { subsystem: "settlement", betId: payload.data.betId },
          });
          await Sentry.flush(2_000);
          throw new NonRetriableError(error.message);
        }
        throw error;
      }
    });

    return result;
  },
);
