import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import { responsibleService, ResponsibleService } from "../responsible/responsible.service";
import { appendAuditLog } from "../audit/append";
import type { WalletTransaction } from "../wallet/types";
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
  /**
   * True when this request found the cash-out already taken and returned the
   * original outcome rather than performing a second one. The caller shows the
   * customer what they were paid either way; the flag is for logs and tests,
   * which need to tell "paid now" from "paid a moment ago".
   */
  replayed?: boolean;
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
    private readonly responsible: ResponsibleService = responsibleService,
  ) {}

  /**
   * May this account cash out at all?
   *
   * INSIDE THE SERVICE, NOT IN A ROUTE. A check that lives only in a caller is
   * a check that the next caller forgets — and this service is reachable from a
   * route, a background job, an admin tool and a test.
   *
   * WHY CASH-OUT IS GATED LIKE PLACING A BET RATHER THAN LIKE A WITHDRAWAL.
   * Withdrawal deliberately permits a self-excluded customer, because trapping
   * someone's money would punish them for using the protection. Cash-out is not
   * that: it is a *wagering decision* — choosing to exit a position at a price —
   * and self-exclusion exists to stop wagering decisions. Nothing is trapped by
   * refusing it, because the bet still settles normally and still pays out. So
   * the rule is the same one placement uses: ACTIVE, and not excluded at the
   * identity level.
   *
   * The identity-level check matters separately from the status. Self-exclusion
   * is registered against a verified identity so it survives re-registration;
   * someone who excludes themselves and signs up again gets a fresh ACTIVE
   * account, and only `assertNotExcluded` catches them.
   */
  private async assertMayCashOut(tx: WalletTransaction, userId: string): Promise<void> {
    const [account] = await tx.execute<{ status: string }>(sql`
      SELECT status::text AS status FROM users WHERE id = ${userId}::uuid
    `);
    if (!account) {
      throw new CashOutUnavailableError("ACCOUNT_NOT_ELIGIBLE", "this account cannot cash out");
    }
    if (account.status !== "ACTIVE") {
      throw new CashOutUnavailableError("ACCOUNT_NOT_ELIGIBLE", "this account cannot cash out");
    }
    // Runs in the cash-out transaction, so an exclusion committed concurrently
    // is either seen here or lands after this request — never half-applied.
    await this.responsible.assertNotExcluded(tx, userId);
  }

  /**
   * Prices a cash-out for its owner, without taking it. Read-only.
   *
   * The ownership and eligibility checks are here rather than only on the
   * take, because a quote is information about somebody's position: what a bet
   * is worth right now, and therefore that it exists and is still running.
   * Handing that to any caller who guesses a bet id is a small leak that costs
   * nothing to close.
   *
   * The remaining stake is priced, not the original, so a partially cashed-out
   * bet quotes what is still at risk.
   */
  async quoteFor(betId: string, userId: string): Promise<CashOutQuote> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const bet = await this.loadBet(tx, betId, false);

      if (bet.userId !== userId) {
        throw new CashOutUnavailableError("ACCOUNT_NOT_ELIGIBLE", "this account cannot cash out");
      }
      if (bet.status !== "PENDING") {
        throw new CashOutUnavailableError(
          "BET_NOT_PENDING",
          `this bet is already ${bet.status.toLowerCase()}`,
        );
      }
      await this.assertMayCashOut(tx, userId);

      const [state] = await tx.execute<{ cashed_out: string }>(sql`
        SELECT cashed_out_stake_minor::text AS cashed_out
        FROM bets WHERE id = ${betId}::uuid
      `);
      const liveStake = bet.stakeMinor - BigInt(state?.cashed_out ?? "0");

      return quoteCashOut(
        liveStake,
        bet.legs,
        this.config.marginBasisPoints,
        this.config.minimumOfferMinor,
      );
    });
  }

  /** Prices a cash-out without taking it or checking who is asking. */
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

      /*
       * Ownership first, and with the same message a missing bet would give.
       * Distinguishing "not yours" from "does not exist" tells a prober which
       * bet ids are real.
       */
      if (bet.userId !== params.userId) {
        throw new CashOutUnavailableError("ACCOUNT_NOT_ELIGIBLE", "this account cannot cash out");
      }

      /*
       * A REPLAY RETURNS THE ORIGINAL RESULT.
       *
       * A cash-out that committed and then lost its response — a dropped
       * connection, a client timeout, a retried fetch — must not come back as
       * an error. The customer has been paid; telling them it failed invites a
       * second attempt and a support ticket about money they already have.
       *
       * The bet itself is the idempotency key here, which is stronger than a
       * client-supplied one: a bet can be fully cashed out exactly once, so
       * this holds even for a client that generates a fresh key on every retry.
       */
      if (bet.status === "CASHED_OUT" && bet.cashoutValueMinor !== null) {
        const [current] = await tx.execute<{ balance: string }>(sql`
          SELECT cached_balance_minor::text AS balance
          FROM wallets WHERE id = ${bet.walletId}::uuid
        `);
        return {
          betId: params.betId,
          offerMinor: bet.cashoutValueMinor,
          balanceAfterMinor: BigInt(current?.balance ?? "0"),
          replayed: true,
        };
      }

      if (bet.status !== "PENDING") {
        throw new CashOutUnavailableError(
          "BET_NOT_PENDING",
          `this bet is already ${bet.status.toLowerCase()}`,
        );
      }

      await this.assertMayCashOut(tx, params.userId);

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

      /*
       * Release the liability before touching the wallet, keeping the global
       * exposure-then-wallet order that stops placement and settlement
       * deadlocking against each other.
       *
       * What is released is the claim MINUS what earlier partial cash-outs
       * already gave back. Releasing the whole claim here would return a slice
       * twice; `GREATEST` would floor it at zero rather than raise, so the
       * market would quietly report no liability while other customers' bets on
       * it still carried some.
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

      /*
       * `cashed_out_stake_minor` becomes the whole stake because that is what a
       * full cash-out is: none of it is still at risk. It also keeps one
       * invariant true for both routes into CASHED_OUT — the one taken here and
       * the one reached by a last partial instalment — which the database now
       * checks rather than trusting.
       *
       * `released_liability_minor` becomes the whole claim, so nothing can
       * release any part of it again.
       */
      await tx.execute(sql`
        UPDATE bets
        SET status = 'CASHED_OUT',
            settled_at = now(),
            cashout_txn_id = ${paid.transactionId}::uuid,
            cashout_value_minor = COALESCE(cashout_value_minor, 0) + ${quote.offerMinor},
            cashed_out_stake_minor = stake_minor,
            released_liability_minor = potential_return_minor - stake_minor
        WHERE id = ${params.betId}::uuid
      `);

      /*
       * The audit row is appended on the SAME transaction as the ledger entries,
       * so a trail that exists is a trail whose money moved. A row written
       * afterwards can be missing for a payment that happened, or present for
       * one that rolled back, and both make the log worse than none.
       */
      await appendAuditLog(tx, {
        actorType: "USER",
        actorId: params.userId,
        action: "BET_CASHOUT_FULL",
        entity: "bet",
        entityId: params.betId,
        after: {
          offerMinor: quote.offerMinor.toString(),
          stakeMinor: bet.stakeMinor.toString(),
        },
        ip: params.ip,
      });

      return {
        betId: params.betId,
        offerMinor: quote.offerMinor,
        balanceAfterMinor: paid.balanceAfterMinor,
      };
    });
  }

  /**
   * Takes PART of a bet's value now, leaving the rest running.
   *
   * Modelled as a reduction of the stake still at risk rather than as a split
   * into two bets. Splitting would double the rows on every partial and make
   * a customer's history unreadable; reducing the live stake keeps one bet
   * that is simply smaller than it was.
   *
   * The remaining stake settles normally. A bet half cashed out pays half.
   */
  async cashOutPartial(params: {
    betId: string;
    userId: string;
    ip: string;
    /** How much of the ORIGINAL stake to buy back. */
    stakePortionMinor: bigint;
    expectedOfferMinor?: bigint;
  }): Promise<CashOutResult & { remainingStakeMinor: bigint }> {
    if (params.stakePortionMinor <= 0n) {
      throw new RangeError("the portion to cash out must be positive");
    }

    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const bet = await this.loadBet(tx, params.betId, true);

      if (bet.userId !== params.userId) {
        throw new CashOutUnavailableError("ACCOUNT_NOT_ELIGIBLE", "this account cannot cash out");
      }
      if (bet.status !== "PENDING") {
        throw new CashOutUnavailableError(
          "BET_NOT_PENDING",
          `this bet is already ${bet.status.toLowerCase()}`,
        );
      }

      await this.assertMayCashOut(tx, params.userId);

      const [state] = await tx.execute<{
        cashed_out: string;
        released: string;
        claim: string;
      }>(sql`
        SELECT cashed_out_stake_minor::text            AS cashed_out,
               released_liability_minor::text          AS released,
               (potential_return_minor - stake_minor)::text AS claim
        FROM bets WHERE id = ${params.betId}::uuid
      `);
      const alreadyOut = BigInt(state?.cashed_out ?? "0");
      const alreadyReleased = BigInt(state?.released ?? "0");
      const claimMinor = BigInt(state?.claim ?? "0");
      const liveStake = bet.stakeMinor - alreadyOut;

      if (params.stakePortionMinor > liveStake) {
        throw new CashOutUnavailableError(
          "VALUE_TOO_SMALL",
          "that is more than the stake still running on this bet",
        );
      }

      /*
       * Price the WHOLE remaining position, then take the requested fraction.
       *
       * Quoting the fraction directly would round differently from the full
       * cash-out of the same bet, so two customers taking the same value by
       * different routes would be paid different amounts. Scaling one quote
       * keeps them consistent.
       */
      const quote = quoteCashOut(
        liveStake,
        bet.legs,
        this.config.marginBasisPoints,
        this.config.minimumOfferMinor,
      );
      // Integer arithmetic throughout; the division truncates, which favours
      // the book by at most one kobo and never overpays.
      const offerMinor = (quote.offerMinor * params.stakePortionMinor) / liveStake;

      if (offerMinor <= 0n) {
        throw new CashOutUnavailableError(
          "VALUE_TOO_SMALL",
          "that portion is worth less than one kobo",
        );
      }
      if (params.expectedOfferMinor !== undefined && offerMinor < params.expectedOfferMinor) {
        throw new CashOutUnavailableError(
          "VALUE_TOO_SMALL",
          "the price moved and this portion is now worth less than the offer you accepted",
        );
      }

      const remainingStake = liveStake - params.stakePortionMinor;
      const takingEverything = remainingStake === 0n;

      /*
       * Release only the liability being bought back, in proportion to the
       * stake retired. Releasing all of it would understate what the book still
       * stands to pay on the part still running.
       *
       * The division truncates, which is deliberate: it releases at most the
       * exact share and never more, so a sequence of partials can only ever
       * leave a market holding slightly TOO MUCH liability. Under-releasing
       * costs a little ceiling headroom; over-releasing admits risk the ceiling
       * exists to refuse. Whatever truncation leaves behind is returned by the
       * final release, which gives back the remainder rather than a proportion.
       *
       * `takingEverything` releases the remainder directly, so a bet closed by
       * instalments ends at exactly zero even when thirds do not divide evenly.
       */
      const releaseMinor = takingEverything
        ? claimMinor - alreadyReleased
        : ((claimMinor * params.stakePortionMinor) / bet.stakeMinor);

      await tx.execute(sql`
        UPDATE exposure e
        SET total_liability_minor = GREATEST(0, e.total_liability_minor - ${releaseMinor})
        , updated_at = now()
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
        amountMinor: offerMinor,
        type: "PAYOUT",
        /*
         * Keyed on the bet AND the cumulative portion.
         *
         * Keying on the bet alone would make a second partial look like a
         * replay of the first and silently pay nothing -- the same trap the
         * casino module avoids by keying on "round plus operation".
         */
        idempotencyKey: `cashout:${params.betId}:${alreadyOut + params.stakePortionMinor}`,
        actor: { type: "USER", id: params.userId, ip: params.ip },
        metadata: {
          kind: "BET_CASHOUT_PARTIAL",
          betId: params.betId,
          stakePortionMinor: params.stakePortionMinor.toString(),
        },
      });

      await tx.execute(sql`
        INSERT INTO bet_cashouts (bet_id, stake_portion_minor, paid_minor, txn_id)
        VALUES (
          ${params.betId}::uuid, ${params.stakePortionMinor}, ${offerMinor},
          ${paid.transactionId}::uuid
        )
      `);

      if (takingEverything) {
        // The last portion closes the bet, so a full cash-out reached in
        // instalments ends in the same state as one taken in a single step.
        await tx.execute(sql`
          UPDATE bets
          SET cashed_out_stake_minor = stake_minor,
              status = 'CASHED_OUT',
              settled_at = now(),
              cashout_txn_id = ${paid.transactionId}::uuid,
              cashout_value_minor = COALESCE(cashout_value_minor, 0) + ${offerMinor},
              released_liability_minor = potential_return_minor - stake_minor
          WHERE id = ${params.betId}::uuid
        `);
      } else {
        await tx.execute(sql`
          UPDATE bets
          SET cashed_out_stake_minor = cashed_out_stake_minor + ${params.stakePortionMinor},
              cashout_value_minor = COALESCE(cashout_value_minor, 0) + ${offerMinor},
              released_liability_minor = released_liability_minor + ${releaseMinor}
          WHERE id = ${params.betId}::uuid
        `);
      }

      await appendAuditLog(tx, {
        actorType: "USER",
        actorId: params.userId,
        action: takingEverything ? "BET_CASHOUT_FULL" : "BET_CASHOUT_PARTIAL",
        entity: "bet",
        entityId: params.betId,
        after: {
          offerMinor: offerMinor.toString(),
          stakePortionMinor: params.stakePortionMinor.toString(),
          remainingStakeMinor: remainingStake.toString(),
          releasedLiabilityMinor: releaseMinor.toString(),
        },
        ip: params.ip,
      });

      return {
        betId: params.betId,
        offerMinor,
        balanceAfterMinor: paid.balanceAfterMinor,
        remainingStakeMinor: remainingStake,
      };
    });
  }

  private async loadBet(tx: WalletTransaction, betId: string, lock: boolean) {
    const [row] = await tx.execute<{
      id: string;
      user_id: string;
      status: string;
      stake_minor: string;
      cashout_value_minor: string | null;
      wallet_id: string | null;
    }>(
      lock
        ? sql`
            SELECT b.id, b.user_id, b.status::text AS status, b.stake_minor::text AS stake_minor,
                   b.cashout_value_minor::text AS cashout_value_minor,
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
                   b.cashout_value_minor::text AS cashout_value_minor,
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
      cashoutValueMinor:
        row.cashout_value_minor === null ? null : BigInt(row.cashout_value_minor),
      walletId: row.wallet_id,
      legs,
    };
  }
}

export const cashOutService = new CashOutService();
