import * as Sentry from "@sentry/nextjs";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { oddsCadence } from "@/modules/odds/cadence";
import { OddsApiIoProvider } from "@/modules/odds/odds-api-io";
import { heartbeatService, StagedError } from "@/modules/reporting/heartbeat.service";
import { ResultIngestionService } from "@/modules/settlement/ingestion.service";
import { settlementOutbox } from "@/modules/settlement/outbox.service";
import { settlementRecovery } from "@/modules/settlement/recovery.service";
import { settlementService } from "@/modules/settlement/settlement.service";
import { UnsettleableError } from "@/modules/settlement/resolve";
import { inngest } from "../client";

/**
 * Settlement fan-out.
 *
 * One work item per finished match, then one step.run() per bet. Each step is
 * checkpointed and retried independently, which is only safe because settleBet
 * is idempotent: it reads the bet under FOR UPDATE, returns early if terminal,
 * and keys its payout credit off the bet id.
 */

/**
 * Structured, correlated logging.
 *
 * Every line of a run carries the same `runId`, so the story of one run can be
 * pulled out of interleaved output from thirteen functions. The absence of this
 * is why diagnosing the stranded bet took a database archaeology session
 * instead of a grep.
 */
function log(runId: string, stage: string, fields: Record<string, unknown>): void {
  console.info(
    JSON.stringify({ at: new Date().toISOString(), job: "settlement", runId, stage, ...fields }),
  );
}

/**
 * THE BUG THIS SOLVES — read before moving this call.
 *
 * `oddsCadence.claimIfDue` is a one-winner `SET NX` with a TTL. It used to be
 * called OUTSIDE `step.run()`, with a comment explaining that replaying it
 * would report "not due" and skip real work. The reasoning was exactly
 * inverted: code outside a step is what re-executes on every invocation, and
 * code inside one is memoised and never runs twice.
 *
 * Inngest invokes a function once per step. So:
 *
 *   invocation 1  claim succeeds -> ingest step runs -> results stored,
 *                 heartbeat written, step output checkpointed
 *   invocation 2  function replays from the top; the claim is still held BY
 *                 ITS OWN FIRST INVOCATION, returns false, and the function
 *                 returns {skipped: "not due"} -- never reaching the dispatch
 *
 * Everything after the first step was therefore unreachable by construction.
 * Results were ingested, the heartbeat went green, and no settlement was ever
 * dispatched: a real winning bet sat PENDING while the monitor showed success.
 *
 * Inside `step.run` the claim is taken once and the `true` is replayed from the
 * checkpoint, so the rest of the function is reached. The claim's TTL still
 * prevents a *different* scheduled run from doing the work concurrently, which
 * is the property it was actually there for.
 */
async function claimDue(
  step: { run: (id: string, fn: () => Promise<boolean>) => Promise<unknown> },
  runId: string,
): Promise<boolean> {
  const claimed = Boolean(
    await step.run("claim-cadence", () => oddsCadence.claimIfDue("results")),
  );
  if (!claimed) log(runId, "claim", { claimed: false, reason: "not due" });
  return claimed;
}

export const pollMatchResults = inngest.createFunction(
  {
    id: "settlement-poll-results",
    name: "Poll finished matches",
    triggers: { cron: "* * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const runId = heartbeatService.newRunId();
    if (!(await claimDue(step, runId))) {
      return { skipped: true as const, reason: "not due", runId };
    }

    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) throw new NonRetriableError("ODDS_API_KEY is required to poll results");

    /*
     * Ingestion only. This function's job ends at "the result is stored and the
     * intent to settle it is recorded in the same transaction".
     *
     * It deliberately does NOT report a settlement count, because it does not
     * perform settlement. The dispatcher and the bet-level function own that
     * number, and keeping them apart is what stops an ingestion success from
     * masking a settlement failure the way it did before.
     */
    const outcome = await step.run("ingest-results", () =>
      heartbeatService.track("results", async (trackedRunId) => {
        try {
          const events = await new ResultIngestionService(
            new OddsApiIoProvider(apiKey),
          ).pollFinishedEvents();
          log(trackedRunId, "ingest", { ingested: events.length });
          const health = await settlementRecovery.inconsistencyCounts();
          return {
            ingestedResults: events.length,
            finalEvents: events.length,
            pendingAfterRun: health.pendingOnFinalEvents,
          };
        } catch (error) {
          throw new StagedError("ingest", error);
        }
      }),
    );

    log(runId, "complete", { ingested: outcome.ingestedResults });
    return { ingested: outcome.ingestedResults, runId };
  },
);

/**
 * Drains the settlement outbox.
 *
 * SEPARATE FROM THE POLLER ON PURPOSE. The poller needs the odds provider;
 * this needs nothing but the database, because the result it acts on is
 * already stored locally. That separation is what makes settlement survive an
 * exhausted API budget — the state the system was actually in while a customer
 * went unpaid.
 *
 * Every minute, unconditionally: there is no cadence gate here. Handing over
 * already-recorded work costs one indexed query, and the reason to throttle
 * the poller (a third party's quota) simply does not apply.
 */
export const dispatchSettlementOutbox = inngest.createFunction(
  {
    id: "settlement-dispatch-outbox",
    name: "Dispatch settlement outbox",
    triggers: { cron: "* * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const runId = heartbeatService.newRunId();

    const items = await step.run("claim-outbox", () => settlementOutbox.claimBatch(25));
    if (items.length === 0) {
      await step.run("heartbeat-idle", () =>
        heartbeatService.track("settlement-dispatch", async () => ({
          dispatchAttempted: 0,
          dispatchAccepted: 0,
        })),
      );
      return { dispatched: 0, runId };
    }

    log(runId, "dispatch", { claimed: items.length });

    /*
     * Send first, then record. If the send succeeds and the recording fails,
     * the item is re-dispatched later and the fan-out runs again — which is
     * harmless, because settlement is idempotent per bet. The reverse ordering
     * would risk marking work done that was never handed over, and that
     * failure is silent and permanent.
     */
    await step.sendEvent(
      "dispatch-finished-events",
      items.map((item) => ({
        /*
         * The id includes the ATTEMPT, and that is not incidental.
         *
         * It was just `item.idempotencyKey`, which is stable for the life of
         * the work item. Inngest deduplicates by event id, so every
         * re-dispatch of a stale item was silently dropped and `settleEvent`
         * never ran again — which meant the step that completes the outbox
         * row never ran either.
         *
         * Observed in production: six events fully settled (no pending bets,
         * no open markets) whose work items sat at attempt 7, climbing toward
         * the give-up threshold. They would have been marked FAILED and paged
         * somebody about work that had already succeeded — and the stale-item
         * re-claim, the entire point of which is to retry a lost hand-off, was
         * a no-op.
         *
         * Per-attempt ids make a re-dispatch a real delivery, while a REPLAY
         * of the same attempt is still deduplicated, which is the property
         * that was actually wanted.
         */
        id: `${item.idempotencyKey}:${item.attempts}`,
        name: "settlement/event.finished",
        data: { eventId: item.eventId, cancelled: item.cancelled, outboxId: item.id },
      })),
    );

    await step.run("heartbeat-dispatch", () =>
      heartbeatService.track("settlement-dispatch", async () => ({
        dispatchAttempted: items.length,
        dispatchAccepted: items.length,
      })),
    );

    log(runId, "complete", { dispatched: items.length });
    return { dispatched: items.length, runId };
  },
);

/**
 * Finds money that stopped moving and puts it back in the pipeline.
 *
 * The normal path is edge-triggered on a result ARRIVING. If that edge is ever
 * missed the event is invisible forever, because the poller only considers
 * events with no stored result. This is the level-triggered counterpart: it
 * asks whether anything is in a state that should not persist, regardless of
 * how it got there.
 *
 * It enqueues; it never settles. A recovery routine with its own settlement
 * logic is a second implementation of the most consequential code in the
 * system, and the two will disagree eventually.
 */
export const recoverStrandedSettlements = inngest.createFunction(
  {
    id: "settlement-recovery-sweep",
    name: "Recover stranded settlements",
    triggers: { cron: "*/2 * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const runId = heartbeatService.newRunId();

    const result = await step.run("sweep", () =>
      heartbeatService.track("settlement-recovery", async (trackedRunId) => {
        try {
          const swept = await settlementRecovery.sweep();
          log(trackedRunId, "recover", {
            candidates: swept.candidates.length,
            enqueued: swept.enqueued,
            pendingOnFinalEvents: swept.pendingOnFinalEvents,
            wonWithoutPayout: swept.wonWithoutPayout,
            abandoned: swept.abandoned,
          });

          /*
           * A high-priority alert, not a log line.
           *
           * Customer money sitting unpaid after a final result is the single
           * worst state this system can be in, and the previous monitoring was
           * structurally unable to report it. Raised on every sweep that still
           * sees one, so it cannot be missed once and then forgotten.
           */
          if (swept.pendingOnFinalEvents > 0 || swept.wonWithoutPayout > 0) {
            Sentry.captureMessage(
              `settlement inconsistency: ${swept.pendingOnFinalEvents} bet(s) pending on a final ` +
                `result, ${swept.wonWithoutPayout} won bet(s) with no payout`,
              { level: "error", tags: { subsystem: "settlement", runId: trackedRunId } },
            );
            await Sentry.flush(2_000);
          }

          return {
            recoveryCandidates: swept.candidates.length,
            recovered: swept.enqueued,
            pendingAfterRun: swept.pendingOnFinalEvents,
          };
        } catch (error) {
          throw new StagedError("recover", error);
        }
      }),
    );

    return { ...result, runId };
  },
);

const eventSettledSchema = z.object({
  eventId: z.string().uuid(),
  cancelled: z.boolean().default(false),
  outboxId: z.string().uuid().optional(),
});

const betSettlementSchema = z.object({
  betId: z.string().uuid(),
  outboxId: z.string().uuid().optional(),
});

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
    const { eventId, cancelled, outboxId } = payload.data;

    const betIds = await step.run("find-pending-bets", () =>
      settlementService.findPendingBetIds(eventId),
    );
    log(runId, "settle", { eventId, pendingBets: betIds.length });

    for (let offset = 0; offset < betIds.length; offset += DISPATCH_BATCH) {
      const batch = betIds.slice(offset, offset + DISPATCH_BATCH);
      await step.sendEvent(
        `dispatch-bets-${offset / DISPATCH_BATCH}`,
        batch.map((betId) => ({
          // Stable id: a replayed feed produces the same event ids, so
          // Inngest deduplicates the fan-out rather than re-running it.
          id: `settle-bet:${eventId}:${betId}`,
          name: "settlement/bet.requested",
          data: { betId, outboxId },
        })),
      );
    }

    // Markets close only after the bets are dispatched, so a bet can never be
    // stranded on a market nobody will settle.
    const closed = await step.run("close-markets", () =>
      settlementService.closeEventMarkets(eventId, cancelled),
    );

    /*
     * The outbox item is completed HERE, once the fan-out is dispatched and
     * the markets are shut. It is deliberately not completed by the dispatcher
     * — "the scheduler accepted the message" is not "the work is done", and
     * conflating those is the class of mistake that produced the original
     * failure.
     */
    if (outboxId) {
      await step.run("complete-outbox", () => settlementOutbox.markCompleted(outboxId));
    }

    await step.run("heartbeat-settle", () =>
      heartbeatService.track("settlement-events", async () => ({
        settlementCompleted: betIds.length,
        marketClosures: closed,
      })),
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
