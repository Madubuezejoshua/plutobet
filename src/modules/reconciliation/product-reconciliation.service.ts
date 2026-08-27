import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Cross-product reconciliation.
 *
 * The existing wallet reconciliation replays each wallet against its own ledger
 * entries. This asks a different and equally necessary question: does every
 * DOMAIN record agree with the money that moved for it?
 *
 * A wallet can reconcile perfectly while a bet exists whose stake was never
 * debited, or a withdrawal is marked paid with no debit behind it. Those are
 * invisible to a balance replay because the balance is internally consistent —
 * it is the relationship between the domain and the ledger that has broken.
 *
 * EVERY FINDING HERE IS A BUG, NOT A DISCREPANCY TO EXPLAIN
 * The live constraints already prevent all of these. A row returned by any
 * check below means a guard is missing or has been bypassed, so the right
 * response is to investigate the code — not to adjust the number.
 */

export interface ReconciliationFinding {
  check: string;
  severity: "CRITICAL" | "HIGH";
  count: number;
  detail: string;
  sample: string[];
}

export interface ProductReconciliationReport {
  clean: boolean;
  findings: ReconciliationFinding[];
  checkedAt: Date;
}

export class ProductReconciliationService {
  constructor(private readonly wallet: WalletService = walletService) {}

  async run(): Promise<ProductReconciliationReport> {
    const findings: ReconciliationFinding[] = [];

    for (const check of this.checks()) {
      try {
        const finding = await check();
        if (finding) findings.push(finding);
      } catch (error) {
        // A failed check is itself a finding. Silently skipping one would make
        // a clean report mean "nothing was checked".
        findings.push({
          check: "CHECK_FAILED",
          severity: "HIGH",
          count: 1,
          detail: error instanceof Error ? error.message.slice(0, 200) : "a check could not run",
          sample: [],
        });
      }
    }

    return { clean: findings.length === 0, findings, checkedAt: new Date() };
  }

  private checks(): (() => Promise<ReconciliationFinding | null>)[] {
    return [
      () => this.betsWithoutStakeDebit(),
      () => this.paidWithdrawalsWithoutDebit(),
      () => this.succeededDepositsNotCredited(),
      () => this.settledBetsWithoutPayout(),
      () => this.casinoWinsWithoutRound(),
      () => this.bonusesExceedingBonusBalance(),
    ];
  }

  /**
   * A bet whose stake transaction does not exist or is not a debit.
   *
   * The schema makes `stake_txn_id` NOT NULL and unique, so this should be
   * impossible. It is checked anyway because "impossible" and "verified" are
   * different words, and this is the one that would mean free bets.
   */
  private async betsWithoutStakeDebit(): Promise<ReconciliationFinding | null> {
    return this.finding({
      check: "BET_WITHOUT_STAKE_DEBIT",
      severity: "CRITICAL",
      detail: "bets exist whose stake was never debited",
      query: sql`
        SELECT b.id::text AS id
        FROM bets b
        LEFT JOIN ledger_entries e
          ON e.txn_id = b.stake_txn_id AND e.direction = 'DEBIT'
        WHERE e.id IS NULL
        LIMIT 20
      `,
    });
  }

  /** A withdrawal marked PAID with no money having left. */
  private async paidWithdrawalsWithoutDebit(): Promise<ReconciliationFinding | null> {
    return this.finding({
      check: "PAID_WITHDRAWAL_WITHOUT_DEBIT",
      severity: "CRITICAL",
      detail: "withdrawals marked paid with no corresponding debit",
      query: sql`
        SELECT w.id::text AS id
        FROM withdrawals w
        LEFT JOIN ledger_entries e
          ON e.txn_id = w.debit_txn_id AND e.direction = 'DEBIT'
        WHERE w.status = 'PAID' AND e.id IS NULL
        LIMIT 20
      `,
    });
  }

  /**
   * A deposit the provider confirmed that never reached a balance.
   *
   * The customer's money arrived and they cannot see it. Critical, and the
   * kind of failure a customer reports before we notice.
   */
  private async succeededDepositsNotCredited(): Promise<ReconciliationFinding | null> {
    return this.finding({
      check: "DEPOSIT_NOT_CREDITED",
      severity: "CRITICAL",
      detail: "successful deposits that were never credited to a wallet",
      query: sql`
        SELECT p.id::text AS id
        FROM payment_intents p
        WHERE p.status = 'SUCCEEDED' AND p.credited_txn_id IS NULL
          AND p.created_at < now() - INTERVAL '10 minutes'
        LIMIT 20
      `,
    });
  }

  /**
   * A won bet that paid nothing.
   *
   * Excludes bets that are fully cashed out, which legitimately settle without
   * a settlement payout because they were paid earlier.
   */
  private async settledBetsWithoutPayout(): Promise<ReconciliationFinding | null> {
    return this.finding({
      check: "WON_BET_WITHOUT_PAYOUT",
      severity: "CRITICAL",
      detail: "bets settled as won with no payout credited",
      query: sql`
        SELECT b.id::text AS id
        FROM bets b
        WHERE b.status = 'WON'
          AND b.cashed_out_stake_minor < b.stake_minor
          AND NOT EXISTS (
            SELECT 1 FROM ledger_transactions t
            WHERE t.metadata ->> 'betId' = b.id::text
              AND t.type IN ('PAYOUT', 'REFUND')
          )
        LIMIT 20
      `,
    });
  }

  /** A casino payout with no round behind it. */
  private async casinoWinsWithoutRound(): Promise<ReconciliationFinding | null> {
    return this.finding({
      check: "CASINO_PAYOUT_WITHOUT_ROUND",
      severity: "HIGH",
      detail: "casino payouts with no matching game round",
      query: sql`
        SELECT t.id::text AS id
        FROM ledger_transactions t
        WHERE t.metadata ->> 'kind' = 'CASINO_PAYOUT'
          AND NOT EXISTS (
            SELECT 1 FROM game_rounds r WHERE r.credit_txn_id = t.id
          )
        LIMIT 20
      `,
    });
  }

  /**
   * Bonus granted that exceeds what the bonus wallet ever held.
   *
   * Catches a bonus credited to the wrong bucket — which would make it
   * withdrawable, defeating the entire wagering model.
   */
  private async bonusesExceedingBonusBalance(): Promise<ReconciliationFinding | null> {
    return this.finding({
      check: "BONUS_CREDITED_TO_WRONG_BUCKET",
      severity: "CRITICAL",
      detail: "bonus grants that did not land in a BONUS wallet",
      query: sql`
        SELECT b.id::text AS id
        FROM bonuses b
        JOIN ledger_entries e ON e.txn_id = b.grant_txn_id AND e.direction = 'CREDIT'
        JOIN wallets w ON w.id = e.wallet_id
        WHERE w.bucket IS DISTINCT FROM 'BONUS'
        LIMIT 20
      `,
    });
  }

  private async finding(params: {
    check: string;
    severity: "CRITICAL" | "HIGH";
    detail: string;
    query: ReturnType<typeof sql>;
  }): Promise<ReconciliationFinding | null> {
    const rows = await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{ id: string }>(params.query),
    );

    if (rows.length === 0) return null;

    return {
      check: params.check,
      severity: params.severity,
      count: rows.length,
      detail: params.detail,
      // Bounded: a systemic fault could match thousands, and an alert nobody
      // can read is an alert nobody acts on.
      sample: rows.slice(0, 10).map((row) => row.id),
    };
  }
}

export const productReconciliationService = new ProductReconciliationService();
