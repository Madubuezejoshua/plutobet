import { and, eq, inArray, lt, sql } from "drizzle-orm";
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
    const due = await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{ id: string; provider_event_id: string }>(sql`
        SELECT e.id, e.provider_event_id
        FROM events e
        WHERE e.provider = ${this.provider.name}
          AND e.status IN ('PENDING', 'LIVE')
          AND e.starts_at < now() - interval '3 hours'
          AND NOT EXISTS (
            SELECT 1 FROM event_results r WHERE r.event_id = e.id
          )
        ORDER BY e.starts_at
        LIMIT ${MAX_EVENTS_PER_POLL}
      `),
    );

    if (due.length === 0) return [];

    const byProviderId = new Map(due.map((row) => [row.provider_event_id, row.id]));
    const results = await this.provider.getResults([...byProviderId.keys()]);

    const finished: FinishedEvent[] = [];
    for (const result of results) {
      const eventId = byProviderId.get(result.eventId);
      if (!eventId) continue;

      // Still in progress or unknown upstream: leave it for the next tick
      // rather than recording a result the provider has not committed to.
      if (result.status !== "SETTLED" && result.status !== "CANCELLED") continue;

      const cancelled = result.status === "CANCELLED";
      const match: MatchResult = {
        status: cancelled ? "CANCELLED" : "SETTLED",
        periods: this.normalisePeriods(result.periods),
      };

      // A finished match with no regulation score is a provider defect, not a
      // result. Recording it would only produce an UnsettleableError per bet
      // later; skipping leaves it to be retried when the feed catches up.
      if (!cancelled && !match.periods.ft) continue;

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
    }

    return finished;
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
