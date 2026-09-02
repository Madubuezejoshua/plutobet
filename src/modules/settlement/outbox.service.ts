import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";

/**
 * The settlement outbox: closing the gap between "we know the result" and
 * "the bets have been settled".
 *
 * THE FAILURE THIS EXISTS FOR
 * ---------------------------
 * A real winning bet stayed PENDING after its event had been automatically
 * marked SETTLED. The result was committed to PostgreSQL in one transaction
 * and the settlement hand-off was a separate network call to the scheduler.
 * Anything that interrupts the gap between them — a crash, a redeploy, a
 * function replay that returns early — loses the hand-off permanently, because
 * `pollFinishedEvents` only ever looks at events with NO stored result. Once
 * the result exists, the event is never reconsidered.
 *
 * A dual write across two systems with no shared commit cannot be made safe by
 * being careful. It needs a record that commits WITH the data.
 *
 * WHAT THIS GUARANTEES
 * --------------------
 * - The result and the intent to settle it are written atomically. Either both
 *   exist or neither does.
 * - One work item per event, enforced by a unique index rather than by
 *   convention, so the poller and the recovery sweep racing on the same event
 *   produce one item and not two.
 * - Dispatch is retryable for as long as it takes, and needs no provider call:
 *   the result is already local. **Provider budget exhaustion must never be
 *   able to stop money reaching a customer whose result we already have.**
 * - Failed items keep their error and attempt count and stay visible. They are
 *   never deleted to make a dashboard green — an invisible failure is the
 *   thing this whole table exists to prevent.
 */

export type OutboxStatus = "PENDING" | "DISPATCHED" | "COMPLETED" | "FAILED";
export type OutboxSource = "RESULT_INGESTED" | "RECOVERY";

export interface OutboxItem {
  id: string;
  eventId: string;
  idempotencyKey: string;
  status: OutboxStatus;
  source: OutboxSource;
  cancelled: boolean;
  attempts: number;
  lastError: string | null;
}

/**
 * How many times a work item is dispatched before it is given up on.
 *
 * Generous, because the thing being retried is a customer's payout and the
 * usual reasons for failure are transient. `FAILED` is not a resting place —
 * it is a state that must page somebody.
 */
export const MAX_DISPATCH_ATTEMPTS = 10;

/**
 * The longest a stale item may wait before being re-dispatched.
 *
 * An hour. Long enough that a database outage is not hammered, short enough
 * that a customer's payout is never more than an hour behind once the
 * infrastructure recovers.
 */
const MAX_BACKOFF_SECONDS = 3600;

/** Errors can carry a connection string; stored text must not. */
const MAX_ERROR_LENGTH = 300;

/**
 * The event-level idempotency key.
 *
 * Deliberately derived from the event id alone. Settling an event is settling
 * ALL of its pending bets, so a second work item for the same event would fan
 * out over the same bets again. Bet-level idempotency would still prevent a
 * double payout, but the duplicate work would make the audit trail unreadable,
 * and "we would have caught it downstream" is a poor argument for allowing a
 * known-duplicate upstream.
 */
export function settlementIdempotencyKey(eventId: string): string {
  return `settle-event:${eventId}`;
}

export class SettlementOutboxService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Records the intent to settle, INSIDE a caller-owned transaction.
   *
   * Takes the transaction rather than opening its own — that is the entire
   * point. Called from the same transaction that writes the result, so the two
   * commit together or not at all.
   *
   * `ON CONFLICT DO NOTHING` on the idempotency key: a re-ingested result, or
   * the recovery sweep arriving at an event the poller already queued, must not
   * create a second item. Returns whether a row was actually created so the
   * caller can report honestly rather than claiming work it did not create.
   */
  async enqueueWithin(
    tx: WalletTransaction,
    params: { eventId: string; cancelled: boolean; source: OutboxSource },
  ): Promise<{ created: boolean; idempotencyKey: string }> {
    const idempotencyKey = settlementIdempotencyKey(params.eventId);
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO settlement_outbox (event_id, idempotency_key, source, cancelled)
      VALUES (${params.eventId}::uuid, ${idempotencyKey}, ${params.source}, ${params.cancelled})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `);
    return { created: rows.length > 0, idempotencyKey };
  }

  /** Same as `enqueueWithin`, for callers that own no transaction. */
  async enqueue(params: {
    eventId: string;
    cancelled: boolean;
    source: OutboxSource;
  }): Promise<{ created: boolean; idempotencyKey: string }> {
    return this.wallet.withMoneyTransaction(({ tx }) => this.enqueueWithin(tx, params));
  }

  /**
   * Claims a batch of work items for dispatch.
   *
   * `FOR UPDATE SKIP LOCKED` so two dispatcher runs take disjoint batches
   * instead of fighting over the same rows — the standard queue pattern, and
   * the reason two concurrent runs cannot dispatch the same event twice.
   *
   * Re-claims `DISPATCHED` items that have gone stale. A hand-off that was
   * accepted by the scheduler and then never completed is indistinguishable
   * from one that was lost, and leaving it alone forever is how a bet stays
   * unpaid quietly. Re-dispatching is safe: settlement is idempotent per bet.
   *
   * BACKOFF, BOUNDED, WITH JITTER
   * The stale window used to be a flat 600 seconds for every attempt. Two
   * problems with that. A genuinely stuck item was retried every ten minutes
   * until it burned its ten attempts in under two hours, turning a transient
   * outage into an abandoned work item. And because every row shared one
   * deadline, a backlog became eligible in the same instant — a thundering herd
   * against a database that was, by hypothesis, already struggling.
   *
   * The window now doubles per attempt from `staleAfterSeconds`, capped at an
   * hour, multiplied by a random 0.75–1.25. The jitter is the part that spreads
   * a herd; the cap is what stops the twelfth attempt landing next week.
   */
  async claimBatch(limit: number, staleAfterSeconds = 600): Promise<OutboxItem[]> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        event_id: string;
        idempotency_key: string;
        status: OutboxStatus;
        source: OutboxSource;
        cancelled: boolean;
        attempts: number;
        last_error: string | null;
      }>(sql`
        WITH claimed AS (
          SELECT id FROM settlement_outbox
          WHERE (
                  status = 'PENDING'
                  OR (status = 'DISPATCHED'
                      AND dispatched_at < now() - make_interval(
                            secs => (
                              LEAST(
                                ${MAX_BACKOFF_SECONDS}::int,
                                ${staleAfterSeconds}::int * power(2, LEAST(attempts, 6))::int
                              )
                              * (0.75 + random() * 0.5)
                            )::int
                          ))
                )
            AND attempts < ${MAX_DISPATCH_ATTEMPTS}
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE settlement_outbox o
        SET status = 'DISPATCHED',
            dispatched_at = now(),
            attempts = o.attempts + 1,
            updated_at = now()
        FROM claimed
        WHERE o.id = claimed.id
        RETURNING o.id, o.event_id, o.idempotency_key, o.status::text,
                  o.source, o.cancelled, o.attempts, o.last_error
      `);

      return rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        source: row.source,
        cancelled: row.cancelled,
        attempts: Number(row.attempts),
        lastError: row.last_error,
      }));
    });
  }

  /**
   * Re-opens a COMPLETED item because the event is inconsistent again.
   *
   * The idempotency key is per EVENT and permanent, which is what stops two
   * producers double-queueing the same result. It also means a completed item
   * blocks the event from ever being recovered a second time — and events do
   * become inconsistent again, most obviously when an odds sync re-opens
   * markets on a settled fixture.
   *
   * Re-opening the existing row keeps the invariant (one row per event) while
   * letting recovery work more than once. `attempts` is reset because this is a
   * new occurrence, not a continuation of the old one; keeping the old count
   * would retire the row prematurely on an unrelated future problem.
   *
   * Returns whether a row was actually re-opened, so the sweep can report the
   * truth about what it did.
   */
  async reopenIfCompleted(eventId: string): Promise<boolean> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE settlement_outbox
        SET status = 'PENDING', attempts = 0, completed_at = NULL,
            source = 'RECOVERY', last_error = NULL, updated_at = now()
        WHERE idempotency_key = ${settlementIdempotencyKey(eventId)}
          AND status = 'COMPLETED'
        RETURNING id
      `);
      return rows.length > 0;
    });
  }

  /** Marks an item settled. Only a verified settlement should call this. */
  async markCompleted(id: string): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE settlement_outbox
        SET status = 'COMPLETED', completed_at = now(), last_error = NULL, updated_at = now()
        WHERE id = ${id}::uuid
      `);
    });
  }

  /**
   * Records a failed attempt.
   *
   * Returns to `PENDING` so it is retried, unless the attempt budget is spent,
   * in which case it becomes `FAILED` and stays visible. `FAILED` rows are
   * never cleaned up automatically: somebody's money is on the other end of
   * one, and a tidy dashboard is not worth losing that.
   */
  async markFailed(id: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_ERROR_LENGTH,
    );
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE settlement_outbox
        SET status = CASE
              WHEN attempts >= ${MAX_DISPATCH_ATTEMPTS} THEN 'FAILED'::settlement_outbox_status
              ELSE 'PENDING'::settlement_outbox_status
            END,
            last_error = ${message},
            updated_at = now()
        WHERE id = ${id}::uuid
      `);
    });
  }

  /** Counts by status, for the heartbeat and for alerting. */
  async counts(): Promise<Record<OutboxStatus, number> & { abandoned: number }> {
    const rows = await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{ status: OutboxStatus; n: number }>(sql`
        SELECT status::text AS status, count(*)::int AS n
        FROM settlement_outbox GROUP BY status
      `),
    );
    const totals: Record<OutboxStatus, number> & { abandoned: number } = {
      PENDING: 0,
      DISPATCHED: 0,
      COMPLETED: 0,
      FAILED: 0,
      abandoned: 0,
    };
    for (const row of rows) totals[row.status] = Number(row.n);
    totals.abandoned = totals.FAILED;
    return totals;
  }
}

export const settlementOutbox = new SettlementOutboxService();
