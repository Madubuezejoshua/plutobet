import { eq, sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import { bets } from "./schema";
import {
  CashOutUnavailableError,
  ODDS_SCALE,
  quoteCashOut,
  type CashOutLegState,
  type CashOutQuote,
} from "./cashout";

/**
 * Cash-out: buying a bet back before it settles.
 *
 * Lock order matches placement and settlement — bet, then exposure, then
 * wallet — so this cannot deadlock against either. It closes the bet, pays
 * the offer, and releases the liability the bet was holding, all in one
 * transaction.
 */

export interface CashOutConfig {
  /** Operator's cut, in basis points. 500 = 5%. */
  marginBasisPoints: number;
  minimumOfferMinor: bigint;
}

export const DEFAULT_CASHOUT_CONFIG: CashOutConfig = {
  marginBasisPoints: 500,
  minimumOfferMinor: 5_000n, // ₦50
};

export interface CashOutResult {
  betId: string;
  offerMinor: bigint;
  balanceAfterMinor: bigint;
}

function parseOddsToScaled(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new RangeError(`unreadable stored odds "${value}"`);
  return BigInt(match[1]!) * ODDS_SCALE + BigInt((match[2] ?? "").padEnd(3, "0"));
}

export class CashOutService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly config: CashOutConfig = DEFAULT_CASHOUT_CONFIG,
  ) {}

  /** Prices a cash-out without taking it. Read-only. */
  async quote(betId: string): Promise<CashOutQuote> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const bet = await this.loadBet(tx, betId, false);
      return quoteCashOut(
        bet.stakeMinor,
        bet.legs,
        this.config.marginBasisPoints,
        this.config.minimumOfferMinor,
      );
    });
  }

  /**
   * Takes the cash-out.
   *
   * The offer is re-priced HERE, under the bet's row lock, rather than
   * trusting a figure the client quotes back. Prices move between a quote
   * being shown and accepted, and honouring a stale one lets a user wait for
   * the market to move against us and then accept the old number.
   *
   * `expectedOfferMinor` is therefore a guard, not an input: if the freshly
   * computed offer is lower than what the user agreed to, the request is
   * refused so they are never given less than they accepted. A HIGHER offer
   * is paid in full — the user is not penalised for the delay.
   */
  async cashOut(params: {
    betId: string;
    userId: string;
    ip: string;
    expectedOfferMinor?: bigint;
  }): Promise<CashOutResult> {
    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const bet = await this.loadBet(tx, params.betId, true);

      if (bet.userId !== params.userId) {
        throw new CashOutUnavailableError("BET_NOT_PENDING", "this bet does not belong to you");
      }
      if (bet.status !== "PENDING") {
        throw new CashOutUnavailableError(
          "BET_NOT_PENDING",
          `this bet is already ${bet.status.toLowerCase()}`,
        );
      }

      const quote = quoteCashOut(
        bet.stakeMinor,
        bet.legs,
        this.config.marginBasisPoints,
        this.config.minimumOfferMinor,
      );

      if (params.expectedOfferMinor !== undefined && quote.offerMinor < params.expectedOfferMinor) {
        throw new CashOutUnavailableError(
          "VALUE_TOO_SMALL",
          "the price moved and this bet is now worth less than the offer you accepted",
        );
      }

      // Release the liability before touching the wallet, keeping the global
      // exposure-then-wallet order that stops placement and settlement
      // deadlocking against each other.
      await tx.execute(sql`
        UPDATE exposure e
        SET total_liability_minor = GREATEST(
              0,
              e.total_liability_minor - (b.potential_return_minor - b.stake_minor)
            ),
            updated_at = now()
        FROM bets b
        WHERE b.id = ${params.betId}::uuid
          AND e.market_id IN (
            SELECT DISTINCT s.market_id
            FROM bet_legs bl
            JOIN selections s ON s.id = bl.selection_id
            WHERE bl.bet_id = ${params.betId}::uuid
          )
      `);

      const paid = await credit({
        walletId: bet.walletId,
        amountMinor: quote.offerMinor,
        // A cash-out is winnings taken early, not a refund of the stake: it
        // belongs against payouts payable so the house position stays honest.
        type: "PAYOUT",
        // Derived from the bet, so a retried request replays rather than
        // paying a second time.
        idempotencyKey: `cashout:${params.betId}`,
        actor: { type: "USER", id: params.userId, ip: params.ip },
        metadata: { kind: "BET_CASHOUT", betId: params.betId },
      });

      await tx
        .update(bets)
        .set({
          status: "CASHED_OUT",
          settledAt: new Date(),
          cashoutTxnId: paid.transactionId,
          cashoutValueMinor: quote.offerMinor,
        })
        .where(eq(bets.id, params.betId));

      return {
        betId: params.betId,
        offerMinor: quote.offerMinor,
        balanceAfterMinor: paid.balanceAfterMinor,
      };
    });
  }

  private async loadBet(tx: WalletTransaction, betId: string, lock: boolean) {
    const [row] = await tx.execute<{
      id: string;
      user_id: string;
      status: string;
      stake_minor: string;
      wallet_id: string | null;
    }>(
      lock
        ? sql`
            SELECT b.id, b.user_id, b.status::text AS status, b.stake_minor::text AS stake_minor,
                   w.id AS wallet_id
            FROM bets b
            LEFT JOIN wallets w
              ON w.user_id = b.user_id AND w.kind = 'USER' AND w.currency = 'NGN'
              AND w.bucket = 'CASH'
            WHERE b.id = ${betId}::uuid
            FOR UPDATE OF b
          `
        : sql`
            SELECT b.id, b.user_id, b.status::text AS status, b.stake_minor::text AS stake_minor,
                   w.id AS wallet_id
            FROM bets b
            LEFT JOIN wallets w
              ON w.user_id = b.user_id AND w.kind = 'USER' AND w.currency = 'NGN'
              AND w.bucket = 'CASH'
            WHERE b.id = ${betId}::uuid
          `,
    );
    if (!row) throw new CashOutUnavailableError("BET_NOT_PENDING", `unknown bet ${betId}`);
    if (!row.wallet_id) throw new Error(`no NGN wallet for user ${row.user_id}`);

    const legRows = await tx.execute<{
      result: string;
      locked_odds_decimal: string;
      current_price_decimal: string | null;
      selection_status: string;
      market_status: string;
    }>(sql`
      SELECT bl.result::text AS result,
             bl.locked_odds_decimal,
             s.current_price_decimal,
             s.status::text AS selection_status,
             m.status::text AS market_status
      FROM bet_legs bl
      JOIN selections s ON s.id = bl.selection_id
      JOIN markets m ON m.id = s.market_id
      WHERE bl.bet_id = ${betId}::uuid
      ORDER BY bl.id
    `);

    const legs: CashOutLegState[] = legRows.map((leg) => {
      if (leg.result === "LOST") return { result: "LOST" };
      if (leg.result === "VOID") return { result: "VOID" };
      if (leg.result === "WON") {
        return { result: "WON", lockedOddsScaled: parseOddsToScaled(leg.locked_odds_decimal) };
      }
      // A suspended market has no usable price. Reporting null here makes the
      // quote refuse, which is the right answer: we cannot value a position
      // whose market is closed.
      const priceable =
        leg.selection_status === "OPEN" &&
        leg.market_status === "OPEN" &&
        leg.current_price_decimal !== null;
      return {
        result: "PENDING",
        lockedOddsScaled: parseOddsToScaled(leg.locked_odds_decimal),
        currentOddsScaled: priceable ? parseOddsToScaled(leg.current_price_decimal!) : null,
      };
    });

    return {
      id: row.id,
      userId: row.user_id,
      status: row.status,
      stakeMinor: BigInt(row.stake_minor),
      walletId: row.wallet_id,
      legs,
    };
  }
}

export const cashOutService = new CashOutService();
