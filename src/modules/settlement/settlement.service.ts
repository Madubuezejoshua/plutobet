import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { betLegs, bets } from "../betting/schema";
import { markets, selections } from "../odds/schema";
import type { MarketKey } from "../odds/canonical";
import { walletService, WalletService } from "../wallet/wallet.service";
import { settlementOutbox, SettlementOutboxService } from "./outbox.service";
import type { WalletTransaction } from "../wallet/types";
import { eventResults } from "./schema";
import {
  resolveBet,
  resolveLeg,
  settlementPayoutMinor,
  UnsettleableError,
  type LegOutcome,
  type MatchResult,
} from "./resolve";

/**
 * Turns an ingested match result into settled bets and paid-out wallets.
 *
 * LOCK ORDER — must match placement's, or the two deadlock against each other
 * under load:
 *
 *   placement:  selections -> markets -> exposure(asc) -> wallet
 *   settlement: bet        -> exposure(asc)            -> wallet
 *
 * Placement never locks bets and settlement never locks selections for write,
 * so there is no cycle — provided exposure always precedes wallet in BOTH.
 * That ordering is the reason exposure is released before the payout below,
 * even though paying first would read more naturally.
 */

export interface SettleBetOutcome {
  betId: string;
  status: "WON" | "LOST" | "VOID";
  payoutMinor: bigint;
  /** True when the bet was already terminal and this call did nothing. */
  alreadySettled: boolean;
}

type PendingLeg = {
  leg_id: string;
  selection_id: string;
  locked_odds_decimal: string;
  selection_key: string;
  line: string | null;
  market_id: string;
  market_key: string;
};

const ODDS_SCALE = 1000n;

function parseOddsToScaled(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new RangeError(`unreadable stored odds "${value}"`);
  return BigInt(match[1]!) * ODDS_SCALE + BigInt((match[2] ?? "").padEnd(3, "0"));
}

export class SettlementService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly outbox: SettlementOutboxService = settlementOutbox,
  ) {}

  /**
   * Records a final result AND the intent to settle it, atomically.
   *
   * The outbox row is written in the SAME transaction as the result, and that
   * is the whole point. Previously the result committed here and the settlement
   * hand-off was a separate network call afterwards; anything interrupting the
   * gap — a crash, a redeploy, a function replay that returned early — lost the
   * hand-off permanently, because `pollFinishedEvents` only ever considers
   * events with NO stored result. Once the result existed, the event was never
   * looked at again and the bet on it stayed PENDING forever.
   *
   * That is not hypothetical: it is what happened to a real winning bet.
   *
   * Either both rows exist or neither does. A dispatcher drains the outbox
   * afterwards and can retry indefinitely without touching the provider, which
   * is what makes settlement independent of API budget.
   */
  async ingestResult(params: {
    eventId: string;
    provider: string;
    result: MatchResult;
  }): Promise<{ resultId: string; outboxCreated: boolean }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx
        .insert(eventResults)
        .values({
          eventId: params.eventId,
          status: params.result.status,
          periods: params.result.periods,
          provider: params.provider,
        })
        .returning({ id: eventResults.id });
      if (!row) throw new Error("event result insert returned no row");

      const queued = await this.outbox.enqueueWithin(tx, {
        eventId: params.eventId,
        cancelled: params.result.status === "CANCELLED",
        source: "RESULT_INGESTED",
      });

      return { resultId: row.id, outboxCreated: queued.created };
    });
  }

  /** Bets with at least one pending leg on this event. */
  async findPendingBetIds(eventId: string): Promise<string[]> {
    const rows = await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{ bet_id: string }>(sql`
        SELECT DISTINCT b.id AS bet_id
        FROM bets b
        JOIN bet_legs bl ON bl.bet_id = b.id
        JOIN selections s ON s.id = bl.selection_id
        JOIN markets m ON m.id = s.market_id
        WHERE m.event_id = ${eventId}::uuid
          AND b.status = 'PENDING'
        ORDER BY b.id
      `),
    );
    return rows.map((row) => row.bet_id);
  }

  private async latestResult(
    tx: WalletTransaction,
    eventId: string,
  ): Promise<MatchResult | null> {
    const [row] = await tx
      .select({ status: eventResults.status, periods: eventResults.periods })
      .from(eventResults)
      .where(eq(eventResults.eventId, eventId))
      .orderBy(desc(eventResults.ingestedAt))
      .limit(1);
    if (!row) return null;
    return { status: row.status, periods: row.periods };
  }

  /**
   * Settles one bet. Safe to call repeatedly — that is the Phase 4 acceptance
   * criterion, since result feeds replay constantly and Inngest retries steps
   * by design.
   *
   * Idempotency is enforced twice over: this reads the bet under FOR UPDATE
   * and returns early if it is already terminal, and the payout credit carries
   * a bet-derived idempotency key so even a torn retry replays the original
   * ledger transaction rather than paying twice.
   */
  async settleBet(betId: string): Promise<SettleBetOutcome> {
    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const [locked] = await tx.execute<{
        id: string;
        user_id: string;
        status: string;
        stake_minor: string;
        cashed_out_stake_minor: string;
        wallet_id: string | null;
      }>(sql`
        SELECT b.id, b.user_id, b.status::text AS status, b.stake_minor::text AS stake_minor,
               b.cashed_out_stake_minor::text AS cashed_out_stake_minor,
               w.id AS wallet_id
        FROM bets b
        LEFT JOIN wallets w ON w.user_id = b.user_id AND w.kind = 'USER'
                            AND w.currency = 'NGN' AND w.bucket = 'CASH'
        WHERE b.id = ${betId}::uuid
        FOR UPDATE OF b
      `);
      if (!locked) throw new Error(`bet ${betId} not found`);

      // Already terminal: a replayed feed, or a concurrent settlement that
      // committed first. Do nothing rather than attempt a second payout.
      if (locked.status !== "PENDING") {
        return {
          betId,
          status: locked.status as SettleBetOutcome["status"],
          payoutMinor: 0n,
          alreadySettled: true,
        };
      }

      const legs = await tx.execute<PendingLeg>(sql`
        SELECT bl.id AS leg_id, bl.selection_id, bl.locked_odds_decimal,
               s.key AS selection_key, s.line::text AS line,
               m.id AS market_id, m.key AS market_key, m.event_id
        FROM bet_legs bl
        JOIN selections s ON s.id = bl.selection_id
        JOIN markets m ON m.id = s.market_id
        WHERE bl.bet_id = ${betId}::uuid
        ORDER BY bl.id
      `);
      if (legs.length === 0) throw new Error(`bet ${betId} has no legs`);

      // Every leg needs a result before the bet can settle. A partially
      // resolved accumulator stays PENDING — settling it early would either
      // pay a bet that could still lose, or kill one that could still win.
      const resolved: { outcome: LegOutcome; oddsScaled: bigint; legId: string }[] = [];
      for (const leg of legs) {
        const eventId = (leg as PendingLeg & { event_id: string }).event_id;
        const result = await this.latestResult(tx, eventId);
        if (!result) {
          throw new UnsettleableError(
            leg.market_key,
            leg.selection_key,
            `no result ingested for event ${eventId}`,
          );
        }
        resolved.push({
          legId: leg.leg_id,
          oddsScaled: parseOddsToScaled(leg.locked_odds_decimal),
          outcome: resolveLeg(
            leg.market_key as MarketKey,
            leg.selection_key,
            leg.line,
            result,
          ),
        });
      }

      const resolution = resolveBet(resolved);

      /*
       * Settlement pays on the stake STILL AT RISK, not the original.
       *
       * A partial cash-out buys back part of the stake and pays for it there
       * and then. Settling the full original stake afterwards would pay twice
       * for the portion already taken -- a straightforward overpayment, and
       * one that would look like a correct settlement in every log.
       *
       * A fully cashed-out bet never reaches here: it is no longer PENDING.
       */
      const cashedOutMinor = BigInt(locked.cashed_out_stake_minor ?? "0");
      const stakeMinor = BigInt(locked.stake_minor) - cashedOutMinor;
      const payoutMinor = settlementPayoutMinor(stakeMinor, resolution);
      const settledAt = new Date();

      for (const leg of resolved) {
        await tx
          .update(betLegs)
          .set({ result: leg.outcome, settledAt })
          .where(eq(betLegs.id, leg.legId));
      }

      await tx
        .update(bets)
        .set({ status: resolution.outcome, settledAt })
        .where(and(eq(bets.id, betId), eq(bets.status, "PENDING")));

      /*
       * Release the liability this bet reserved at placement.
       *
       * The amount is recomputed from the bet's own immutable columns rather
       * than from the current payout: placement claimed
       * (potential_return - stake) against every market on the slip, so
       * releasing anything else — the actual payout, say — would leave the
       * market's exposure permanently skewed after every void or upset.
       *
       * MINUS what has already been given back. A bet that was partially cashed
       * out has had part of its claim released once already; releasing the whole
       * claim here would return that slice a second time. `GREATEST` floors the
       * result at zero rather than raising, so the double release would not
       * fail — the market would simply report less liability than it holds,
       * which is the direction that lets a ceiling admit risk it should refuse.
       */
      await tx.execute(sql`
        UPDATE exposure e
        SET total_liability_minor = GREATEST(
              0,
              e.total_liability_minor
                - (b.potential_return_minor - b.stake_minor - b.released_liability_minor)
            ),
            updated_at = now()
        FROM bets b
        WHERE b.id = ${betId}::uuid
          AND e.market_id IN (
            SELECT DISTINCT s.market_id
            FROM bet_legs bl
            JOIN selections s ON s.id = bl.selection_id
            WHERE bl.bet_id = ${betId}::uuid
          )
      `);

      /*
       * Record that the whole claim is now released.
       *
       * `settleBet` returns early for a bet that is no longer PENDING, so this
       * is belt and braces rather than the primary guard — but the recovery
       * sweep re-runs this path deliberately, and a column that says "nothing
       * left to release" is a fact a later reader can check. It is also what
       * the `bets_released_liability_valid` bound is measured against.
       */
      await tx.execute(sql`
        UPDATE bets
        SET released_liability_minor = potential_return_minor - stake_minor
        WHERE id = ${betId}::uuid
      `);

      if (payoutMinor > 0n) {
        if (!locked.wallet_id) throw new Error(`no NGN wallet for user ${locked.user_id}`);
        await credit({
          walletId: locked.wallet_id,
          amountMinor: payoutMinor,
          // A void bet returns the stake; that is a REFUND, not winnings, and
          // the ledger counterparty differs (stakes liability vs payouts
          // payable). Collapsing them would misstate the house position.
          type: resolution.outcome === "VOID" ? "REFUND" : "PAYOUT",
          // Derived from the bet, never from a timestamp or random value, so
          // a retry replays rather than pays again.
          idempotencyKey: `settlement:${resolution.outcome.toLowerCase()}:${betId}`,
          actor: { type: "SYSTEM" },
          metadata: { kind: "BET_SETTLEMENT", betId, outcome: resolution.outcome },
        });
      }

      return {
        betId,
        status: resolution.outcome,
        payoutMinor,
        alreadySettled: false,
      };
    });
  }

  /**
   * Closes the event's markets once its bets are settled, so nothing new can
   * be placed on a finished match.
   */
  /** Returns how many markets were closed, so monitoring can count them. */
  async closeEventMarkets(eventId: string, cancelled: boolean): Promise<number> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const status = cancelled ? "VOID" : "SETTLED";
      const marketIds = await tx
        .select({ id: markets.id })
        .from(markets)
        .where(eq(markets.eventId, eventId));
      const ids = marketIds.map((row) => row.id);
      if (ids.length > 0) {
        await tx
          .update(selections)
          .set({ status, updatedAt: new Date() })
          .where(inArray(selections.marketId, ids));
        await tx
          .update(markets)
          .set({ status, updatedAt: new Date() })
          .where(eq(markets.eventId, eventId));
      }
      return ids.length;
    });
  }
}

export const settlementService = new SettlementService();
