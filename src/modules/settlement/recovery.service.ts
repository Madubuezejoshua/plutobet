import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import { appendAuditLog } from "../audit/append";
import { settlementOutbox, SettlementOutboxService } from "./outbox.service";

/**
 * Finds money that stopped moving, and puts it back in the pipeline.
 *
 * WHY A SWEEP IS NOT OPTIONAL
 * ---------------------------
 * The normal path is edge-triggered: a result ARRIVES, and that transition
 * queues the settlement. Every edge-triggered system has the same weakness —
 * if the edge is missed, nothing ever happens again, because the trigger was
 * the transition and the transition is over.
 *
 * That is precisely how a real winning bet was lost. Its result was ingested
 * and the hand-off failed; afterwards `pollFinishedEvents` skipped the event
 * forever, because it only considers events with NO stored result. The event
 * was permanently invisible to the only thing that could have saved it.
 *
 * A sweep is level-triggered: it asks "is anything in a state that should not
 * persist?" and does not care how it got there. That is the difference between
 * a system that recovers and one that needs a human to notice.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never touches a bet, a wallet, a market or a ledger row. It only ENQUEUES
 * work for the ordinary settlement path — the same path a normal result takes.
 * A recovery routine that settles bets by its own logic is a second
 * implementation of the most consequential code in the system, and the two
 * will disagree eventually.
 *
 * It also never calls the odds provider. Every inconsistency it looks for is
 * detectable from stored data alone, which is what makes recovery work when
 * the API budget is exhausted — the state this system was actually in.
 */

export interface RecoveryCandidate {
  eventId: string;
  reason: string;
  pendingBets: number;
  cancelled: boolean;
}

export interface RecoverySweepResult {
  candidates: RecoveryCandidate[];
  enqueued: number;
  /** Bets still PENDING on an event holding a final result. The alarm number. */
  pendingOnFinalEvents: number;
  /** Won bets with no payout transaction. Should always be zero. */
  wonWithoutPayout: number;
  /** Final events whose markets are still open. */
  finalEventsWithOpenMarkets: number;
  /** Work items dispatched but never completed. */
  stalledDispatches: number;
  /** Work items that exhausted their attempts and need a human. */
  abandoned: number;
  /** Markets still holding liability although every bet on them is settled. */
  unreleasedExposureMarkets: number;
}

/** How long a dispatched item may sit incomplete before it is suspicious. */
const STALLED_DISPATCH_SECONDS = 600;

export class SettlementRecoveryService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly outbox: SettlementOutboxService = settlementOutbox,
  ) {}

  /**
   * Finds every event that holds a final result but has not finished settling.
   *
   * ONE query covering both symptoms, because they have one cause and one fix:
   * a pending bet on a settled event, and an open market on a settled event,
   * are both "the settlement fan-out did not complete here".
   *
   * Deliberately NOT filtered on `events.status`. The stranded event was
   * already marked SETTLED — filtering on the status would have excluded the
   * exact row this exists to find. What matters is the presence of a final
   * RESULT, not the label on the event.
   */
  async findCandidates(limit = 100): Promise<RecoveryCandidate[]> {
    const rows = await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{
        event_id: string;
        pending_bets: number;
        open_markets: number;
        cancelled: boolean;
      }>(sql`
        SELECT e.id AS event_id,
               count(DISTINCT b.id) FILTER (WHERE b.status = 'PENDING')::int AS pending_bets,
               count(DISTINCT m.id) FILTER (WHERE m.status = 'OPEN')::int AS open_markets,
               bool_or(r.status = 'CANCELLED') AS cancelled
        FROM events e
        JOIN event_results r ON r.event_id = e.id
        LEFT JOIN markets m ON m.event_id = e.id
        LEFT JOIN selections s ON s.market_id = m.id
        LEFT JOIN bet_legs bl ON bl.selection_id = s.id
        LEFT JOIN bets b ON b.id = bl.bet_id
        GROUP BY e.id
        HAVING count(DISTINCT b.id) FILTER (WHERE b.status = 'PENDING') > 0
            OR count(DISTINCT m.id) FILTER (WHERE m.status = 'OPEN') > 0
        ORDER BY e.id
        LIMIT ${limit}
      `),
    );

    return rows.map((row) => ({
      eventId: row.event_id,
      pendingBets: Number(row.pending_bets),
      cancelled: Boolean(row.cancelled),
      reason:
        Number(row.pending_bets) > 0
          ? `${row.pending_bets} pending bet(s) on an event with a final result`
          : `${row.open_markets} open market(s) on an event with a final result`,
    }));
  }

  /**
   * Queues every candidate for ordinary settlement, and records that it did.
   *
   * Idempotent twice over: the outbox's unique idempotency key means a second
   * sweep adds nothing, and settlement itself is idempotent per bet. Two
   * concurrent sweeps therefore cannot pay anybody twice — the first inserts,
   * the second conflicts and moves on.
   *
   * The audit row is the answer to "why did this settle now, hours late?".
   * Recovery that leaves no trace is indistinguishable from a bug that fixed
   * itself, and neither should be something an operator has to guess about.
   */
  async sweep(limit = 100): Promise<RecoverySweepResult> {
    const candidates = await this.findCandidates(limit);
    let enqueued = 0;

    for (const candidate of candidates) {
      let reopened = false;
      const created = await this.wallet.withMoneyTransaction(async ({ tx }) => {
        const queued = await this.outbox.enqueueWithin(tx, {
          eventId: candidate.eventId,
          cancelled: candidate.cancelled,
          source: "RECOVERY",
        });
        if (!queued.created) {
          /*
           * A row already exists. If it is COMPLETED, this is a SECOND
           * inconsistency on an event that was settled once before — markets
           * re-opened by an odds sync, most likely. The permanent per-event
           * key would otherwise block recovery forever, so re-open it.
           *
           * If it is PENDING or DISPATCHED the work is already queued and
           * there is nothing to do; if it is FAILED it needs a human, and
           * quietly resetting it would hide that.
           */
          reopened = await this.outbox.reopenIfCompleted(candidate.eventId);
          return reopened;
        }

        await appendAuditLog(tx, {
          actorType: "SYSTEM",
          actorId: null,
          action: "SETTLEMENT_RECOVERY_ENQUEUED",
          entity: "event",
          entityId: candidate.eventId,
          reason: `recovery sweep found ${candidate.reason}`,
          before: null,
          after: {
            idempotencyKey: queued.idempotencyKey,
            pendingBets: candidate.pendingBets,
            cancelled: candidate.cancelled,
          },
          ip: null,
        });
        return true;
      });
      if (created) enqueued += 1;
    }

    const health = await this.inconsistencyCounts();
    return { candidates, enqueued, ...health };
  }

  /**
   * The numbers an alert reads. Each one should be zero in a healthy system.
   *
   * Kept separate from the sweep so monitoring can ask the question without
   * enqueueing anything — a read-only health probe and a repair action should
   * never be the same call.
   */
  async inconsistencyCounts(): Promise<{
    pendingOnFinalEvents: number;
    wonWithoutPayout: number;
    finalEventsWithOpenMarkets: number;
    stalledDispatches: number;
    abandoned: number;
    unreleasedExposureMarkets: number;
  }> {
    const [row] = await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{
        pending_on_final: number;
        won_without_payout: number;
        final_open_markets: number;
        stalled: number;
        abandoned: number;
        unreleased_exposure: number;
      }>(sql`
        SELECT
          (SELECT count(DISTINCT b.id)::int
             FROM bets b
             JOIN bet_legs bl ON bl.bet_id = b.id
             JOIN selections s ON s.id = bl.selection_id
             JOIN markets m ON m.id = s.market_id
             JOIN event_results r ON r.event_id = m.event_id
            WHERE b.status = 'PENDING') AS pending_on_final,

          (SELECT count(*)::int FROM bets b
            WHERE b.status = 'WON'
              AND NOT EXISTS (
                SELECT 1 FROM ledger_transactions t
                 WHERE t.type = 'PAYOUT'
                   AND (t.reference = b.id::text OR t.metadata->>'betId' = b.id::text)
              )) AS won_without_payout,

          (SELECT count(DISTINCT m.event_id)::int
             FROM markets m
             JOIN event_results r ON r.event_id = m.event_id
            WHERE m.status = 'OPEN') AS final_open_markets,

          (SELECT count(*)::int FROM settlement_outbox
            WHERE status = 'DISPATCHED'
              AND dispatched_at < now() - make_interval(secs => ${STALLED_DISPATCH_SECONDS}::int)) AS stalled,

          (SELECT count(*)::int FROM settlement_outbox WHERE status = 'FAILED') AS abandoned,

          /*
           * Liability still reserved on a market whose every bet is settled.
           *
           * Reported, never repaired here. This sweep enqueues work for the
           * ordinary settlement path and touches no money row directly, and
           * exposure is a money row. A residue is also not always a bug: it
           * can be a correction somebody made deliberately.
           *
           * It is surfaced because it was invisible, and being invisible is
           * how a duplicate submit quietly ate a market ceiling for months.
           */
          (SELECT count(*)::int FROM exposure x
            WHERE x.total_liability_minor > 0
              AND NOT EXISTS (
                SELECT 1 FROM bets b
                  JOIN bet_legs bl ON bl.bet_id = b.id
                  JOIN selections s ON s.id = bl.selection_id
                 WHERE s.market_id = x.market_id AND b.status = 'PENDING'
              )) AS unreleased_exposure
      `),
    );

    return {
      pendingOnFinalEvents: Number(row?.pending_on_final ?? 0),
      wonWithoutPayout: Number(row?.won_without_payout ?? 0),
      finalEventsWithOpenMarkets: Number(row?.final_open_markets ?? 0),
      stalledDispatches: Number(row?.stalled ?? 0),
      abandoned: Number(row?.abandoned ?? 0),
      unreleasedExposureMarkets: Number(row?.unreleased_exposure ?? 0),
    };
  }
}

export const settlementRecovery = new SettlementRecoveryService();
