import { sql } from "drizzle-orm";
import { assertReviewEnvironment } from "@/lib/review-mode";
import {
  dispatchSettlementOutbox,
  pollMatchResults,
  recoverStrandedSettlements,
  settleBet,
  settleEvent,
} from "@/inngest/functions/settlement";
import type {
  EventResult,
  OddsProvider,
  OddsSnapshot,
  ProviderEventStatus,
  SportEvent,
} from "@/modules/odds/provider";
import { ResultIngestionService } from "@/modules/settlement/ingestion.service";
import { settlementOutbox } from "@/modules/settlement/outbox.service";
import { walletService } from "@/modules/wallet/wallet.service";
import { replayScheduledFunction } from "./inngest-harness";

/**
 * Drives one match all the way from "the referee blew the whistle" to "the
 * customer's balance changed", on a review server, through the components that
 * do it in production.
 *
 * WHY THIS EXISTS. The browser journey could prove sign-in, placement, admin
 * visibility and cash-out, and stopped exactly where the interesting part
 * begins: a bet a customer placed in a browser had never been watched reaching
 * WON, LOST or VOID. Every settlement claim rested on Vitest calling services
 * directly. That proves the logic and says nothing about whether the thing a
 * customer sees ever changes.
 *
 * WHAT IS REAL HERE, AND IT IS ALMOST ALL OF IT:
 *
 *   - `ResultIngestionService` is the production class, driven through its
 *     ordinary `pollFinishedEvents()` entry point. It selects due events with
 *     its own query, applies its own backoff, and calls
 *     `settlementService.ingestResult`, which writes the result row AND the
 *     outbox item in ONE transaction. Nothing here writes either.
 *   - The registered Inngest functions run — `dispatchSettlementOutbox`,
 *     then `settleEvent` through the event it emits, then `settleBet` through
 *     the events THAT emits. `settleBet` is never called directly; it is
 *     reached the way the platform reaches it, so a function missing from the
 *     serve route would fail here for the same reason it would in production.
 *   - `replayScheduledFunction` invokes each handler once per step, replaying
 *     from the top with completed steps served from a checkpoint. That is what
 *     Inngest does, and modelling it is what caught the cadence-claim bug that
 *     left a real winning bet unpaid while the monitor showed success.
 *
 * WHAT IS SUBSTITUTED, AND IT IS EXACTLY ONE THING: the provider's answer. A
 * review server has no live results feed and must not have one. The controlled
 * score below is the only fabricated input, and it enters through the same
 * `OddsProvider.getResults` seam that odds-api.io enters through.
 *
 * THE ONE DIRECT WRITE, NAMED. `windBackKickoff` moves an event's `starts_at`
 * into the past, because ingestion only considers matches that started more
 * than three hours ago and a test cannot wait three hours. That column is a
 * SCHEDULE, not a result: it is not a wallet balance, a ledger row, a bet
 * status, a bet outcome, a payout record, an event result, an outbox status or
 * an exposure value, and none of those is written anywhere in this file.
 */

/** The registry, in the same order `src/app/api/inngest/route.ts` serves it. */
const SETTLEMENT_REGISTRY = [
  pollMatchResults,
  dispatchSettlementOutbox,
  recoverStrandedSettlements,
  settleEvent,
  settleBet,
];

export interface ControlledResult {
  /** Regulation score. 1X2 settles against this, never against a shootout. */
  ft?: { home: number; away: number };
  /** A cancelled match voids every bet on it and returns the stake. */
  cancelled?: boolean;
}

/**
 * An `OddsProvider` that knows one thing: the score of the matches it was
 * handed.
 *
 * `name` is `"demo"` because `ResultIngestionService` filters due events by
 * `e.provider = provider.name`, and the review fixtures are seeded under that
 * provider. Calling it something else would silently select nothing and the
 * journey would report "no events were due" rather than failing.
 *
 * Every other method throws. A review run must never reach for fixtures, odds
 * or a delta feed, and a method that quietly returned `[]` would let it try.
 */
export class ControlledResultProvider implements OddsProvider {
  readonly name = "demo";

  constructor(private readonly results: Map<string, ControlledResult>) {}

  async listEvents(): Promise<SportEvent[]> {
    throw new Error("the controlled result provider does not list events");
  }

  async listLiveEvents(): Promise<SportEvent[]> {
    throw new Error("the controlled result provider does not list live events");
  }

  async getOdds(): Promise<OddsSnapshot[]> {
    throw new Error("the controlled result provider does not price markets");
  }

  async getUpdatedSince(): Promise<OddsSnapshot[] | null> {
    throw new Error("the controlled result provider has no delta feed");
  }

  async getResults(providerEventIds: string[]): Promise<EventResult[]> {
    const out: EventResult[] = [];
    for (const id of providerEventIds) {
      const controlled = this.results.get(id);
      /*
       * An event this provider was not told about is SKIPPED, not answered.
       * That is what the real adapter does when the vendor has forgotten a
       * fixture, and ingestion then backs it off rather than resolving it.
       * Answering "0-0, finished" for an unknown id would settle other tests'
       * matches as a side effect of running this one.
       */
      if (!controlled) continue;
      const status: ProviderEventStatus = controlled.cancelled ? "CANCELLED" : "SETTLED";
      const ft = controlled.ft ?? { home: 0, away: 0 };
      out.push({
        eventId: id,
        status,
        home: ft.home,
        away: ft.away,
        periods: controlled.cancelled ? {} : { ft },
      });
    }
    return out;
  }
}

/**
 * Moves an event's kickoff into the past so ingestion considers it due.
 *
 * `result_next_poll_at` is cleared at the same time. A previous drive that
 * found nothing to say will have backed the event off, and an event deferred
 * five minutes into the future is not due — which would make the second drive
 * of the same event silently do nothing and the test fail with "still
 * PENDING", the least informative symptom available.
 */
async function windBackKickoff(eventId: string, hoursAgo: number): Promise<void> {
  await walletService.withMoneyTransaction(async ({ tx }) => {
    await tx.execute(sql`
      UPDATE events
      SET starts_at = now() - make_interval(secs => ${Math.round(hoursAgo * 3600)}),
          result_next_poll_at = NULL,
          updated_at = now()
      WHERE id = ${eventId}::uuid
    `);
  });
}

export interface DriveOutcome {
  ingested: number;
  dispatched: number;
  settleEventRuns: number;
  settleBetRuns: number;
  outbox: Record<string, number>;
  listenerErrors: { event: string; message: string }[];
}

/**
 * Ingest → outbox → dispatch → settle, once, for the events named.
 *
 * Safe to call twice with the same arguments: that is the replay case the
 * journey asserts, and the correct answer to it is that nothing is paid a
 * second time.
 */
export async function driveSettlement(params: {
  results: { providerEventId: string; eventId: string; result: ControlledResult }[];
  /** Also run the level-triggered recovery sweep afterwards. */
  sweep?: boolean;
}): Promise<DriveOutcome> {
  assertReviewEnvironment("QA settlement drive");

  for (const entry of params.results) {
    await windBackKickoff(entry.eventId, 4);
  }

  const provider = new ControlledResultProvider(
    new Map(params.results.map((r) => [r.providerEventId, r.result])),
  );
  const finished = await new ResultIngestionService(provider).pollFinishedEvents();

  const dispatch = await replayScheduledFunction(dispatchSettlementOutbox, SETTLEMENT_REGISTRY);

  const sweep = params.sweep
    ? await replayScheduledFunction(recoverStrandedSettlements, SETTLEMENT_REGISTRY)
    : null;

  const counts = await settlementOutbox.counts();

  return {
    ingested: finished.length,
    dispatched: dispatch.events.filter((e) => e.name === "settlement/event.finished").length,
    settleEventRuns: dispatch.steps.filter((s) => s.startsWith("settle-event:")).length,
    settleBetRuns: dispatch.steps.filter((s) => s.startsWith("settle-bet:")).length,
    outbox: counts as unknown as Record<string, number>,
    listenerErrors: [...dispatch.listenerErrors, ...(sweep?.listenerErrors ?? [])],
  };
}
