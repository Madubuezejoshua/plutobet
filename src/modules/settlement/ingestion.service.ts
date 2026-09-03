import { eq, sql } from "drizzle-orm";
import { events } from "../odds/schema";
import type { OddsProvider } from "../odds/provider";
import { walletService, WalletService } from "../wallet/wallet.service";
import { SettlementService, settlementService } from "./settlement.service";
import type { MatchResult, PeriodScore } from "./resolve";

/**
 * Pulls finished matches from the odds provider and records their results.
 *
 * This is the trigger the settlement pipeline was missing: settleBet is only
 * ever reached because something noticed a match had ended. Without it the
 * engine settles nothing and every bet sits PENDING forever.
 *
 * It is the ONLY caller of provider.getResults, keeping the "one component
 * talks upstream" rule intact — the budget guard inside the adapter still
 * applies.
 */

/**
 * How long after kickoff a football match is assumed to be over.
 *
 * 90 minutes plus half-time plus stoppage plus a margin for extra time and
 * penalties. Polling earlier wastes API budget on in-progress matches;
 * polling much later delays every payout. Cup ties running to shootouts are
 * the long tail this covers.
 */
const ASSUMED_FINISHED_AFTER_MS = 3 * 60 * 60_000;
const ASSUMED_FINISHED_AFTER_SECONDS = ASSUMED_FINISHED_AFTER_MS / 1000;

/**
 * Backoff for an event the provider has not scored yet.
 *
 * Five minutes doubling to a day. The first few retries are quick because a
 * result usually appears within minutes of a match ending; the cap stops a
 * long feed outage from pushing events years out.
 */
const BASE_BACKOFF_SECONDS = 5 * 60;
const MAX_BACKOFF_SECONDS = 24 * 60 * 60;
/** Provider calls are the scarce resource — cap how many events per tick. */
const MAX_EVENTS_PER_POLL = 20;

export interface FinishedEvent {
  eventId: string;
  cancelled: boolean;
}

export class ResultIngestionService {
  constructor(
    private readonly provider: OddsProvider,
    private readonly settlement: SettlementService = settlementService,
    private readonly wallet: WalletService = walletService,
  ) {}

  /**
   * Finds events past their assumed finish time that still have no result,
   * fetches those results, and records them.
   *
   * Returns the events now ready to settle. Ingestion and settlement are
   * separated deliberately: recording what the provider said is cheap and
   * safe to repeat, while settling moves money and needs its own retry and
   * concurrency treatment.
   */
  async pollFinishedEvents(): Promise<FinishedEvent[]> {
    /*
     * MONEY WAITING COMES FIRST.
     *
     * This was a plain `ORDER BY starts_at` over the 20 oldest unresolved
     * events. Fixtures the provider never scores — lower-league and amateur
     * matches, of which a 14-day horizon ingests hundreds — stay unresolved
     * forever and were re-fetched on every run, so newer events queued behind
     * them. A real customer bet was observed sitting 59th of 60; four cycles
     * and roughly 80 provider calls never reached it.
     *
     * Two changes fix it. Events with a PENDING bet sort first, because a
     * delay only matters to somebody when money is riding on it. And each
     * event carries its own `result_next_poll_at`, so a permanently unscored
     * fixture backs off instead of occupying a slot every cycle.
     *
     * `result_next_poll_at IS NULL` means never tried, which must be eligible.
     */
    const due = await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{ id: string; provider_event_id: string; has_pending_bet: boolean }>(sql`
        SELECT e.id, e.provider_event_id,
               EXISTS (
                 SELECT 1
                 FROM bet_legs l
                 JOIN bets b ON b.id = l.bet_id
                 JOIN selections s ON s.id = l.selection_id
                 JOIN markets m ON m.id = s.market_id
                 WHERE m.event_id = e.id AND b.status = 'PENDING'
               ) AS has_pending_bet
        FROM events e
        WHERE e.provider = ${this.provider.name}
          AND e.status IN ('PENDING', 'LIVE')
          AND e.starts_at < now() - make_interval(secs => ${ASSUMED_FINISHED_AFTER_SECONDS})
          AND (e.result_next_poll_at IS NULL OR e.result_next_poll_at <= now())
          AND NOT EXISTS (
            SELECT 1 FROM event_results r WHERE r.event_id = e.id
          )
        ORDER BY has_pending_bet DESC, e.starts_at
        LIMIT ${MAX_EVENTS_PER_POLL}
      `),
    );

    if (due.length === 0) return [];

    const byProviderId = new Map(due.map((row) => [row.provider_event_id, row.id]));
    const results = await this.provider.getResults([...byProviderId.keys()]);

    const finished: FinishedEvent[] = [];
    // Every due event the provider actually spoke about, however it answered.
    // What is missing from this set at the end gets backed off below.
    const answered = new Set<string>();
    for (const result of results) {
      const eventId = byProviderId.get(result.eventId);
      if (!eventId) continue;

      // Still in progress or unknown upstream: leave it for the next tick
      // rather than recording a result the provider has not committed to.
      if (result.status !== "SETTLED" && result.status !== "CANCELLED") {
        await this.deferEvent(eventId);
        answered.add(eventId);
        continue;
      }

      const cancelled = result.status === "CANCELLED";
      const match: MatchResult = {
        status: cancelled ? "CANCELLED" : "SETTLED",
        periods: this.normalisePeriods(result.periods),
      };

      // A finished match with no regulation score is a provider defect, not a
      // result. Recording it would only produce an UnsettleableError per bet
      // later; deferring leaves it to be retried when the feed catches up.
      if (!cancelled && !match.periods.ft) {
        await this.deferEvent(eventId);
        answered.add(eventId);
        continue;
      }

      await this.settlement.ingestResult({
        eventId,
        provider: this.provider.name,
        result: match,
      });

      await this.wallet.withMoneyTransaction(async ({ tx }) => {
        await tx
          .update(events)
          .set({ status: cancelled ? "CANCELLED" : "SETTLED", updatedAt: new Date() })
          .where(eq(events.id, eventId));
      });

      finished.push({ eventId, cancelled });
      answered.add(eventId);
    }

    /*
     * Defer every due event the provider said NOTHING about.
     *
     * `getResults` now skips an event the provider has forgotten rather than
     * throwing, so such an event simply does not appear in `results`. Without
     * this, it is never deferred either — it stays eligible, sorts to the head
     * of the queue on the next tick, and is re-fetched every minute forever,
     * spending the daily budget on a fixture that will never resolve and
     * pushing real bets down the queue. The starvation fix, undone by the
     * omission it did not anticipate.
     *
     * Deferring is not resolving. The event keeps its PENDING status and comes
     * back on the backoff schedule, because a provider briefly missing data
     * must never become a permanently unsettled bet.
     */
    for (const row of due) {
      if (!answered.has(row.id)) await this.deferEvent(row.id);
    }

    return finished;
  }

  /**
   * Backs an event off after a poll that produced no usable result.
   *
   * Exponential in the attempt count and capped, so a fixture the provider
   * never scores drifts to a daily retry instead of occupying a slot on every
   * cycle — which is what let one such event starve a match with real money on
   * it. The event is NEVER marked resolved here: a provider briefly missing
   * data must not turn into a bet that is never settled, so this only defers.
   *
   * The cap matters as much as the growth. Without it a long-running feed
   * outage would push every affected event years into the future, and they
   * would still be waiting long after the feed recovered.
   */
  private async deferEvent(eventId: string): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE events
        SET result_poll_attempts = result_poll_attempts + 1,
            result_last_polled_at = now(),
            result_next_poll_at = now() + make_interval(
              secs => LEAST(
                ${MAX_BACKOFF_SECONDS}::int,
                ${BASE_BACKOFF_SECONDS}::int * power(2, LEAST(result_poll_attempts, 10))::int
              )
            ),
            updated_at = now()
        WHERE id = ${eventId}::uuid
      `);
    });
  }

  /**
   * Coerces provider period scores into integers.
   *
   * Scores arrive as whatever JSON the vendor sent. A non-numeric or
   * fractional "goal" would silently corrupt a settlement comparison, so
   * anything that is not a clean integer pair is dropped rather than rounded.
   */
  private normalisePeriods(raw: Record<string, PeriodScore>): Record<string, PeriodScore> {
    const clean: Record<string, PeriodScore> = {};
    for (const [period, score] of Object.entries(raw ?? {})) {
      const home = Number(score?.home);
      const away = Number(score?.away);
      if (!Number.isInteger(home) || !Number.isInteger(away)) continue;
      if (home < 0 || away < 0) continue;
      clean[period] = { home, away };
    }
    return clean;
  }
}
