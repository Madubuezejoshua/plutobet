import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Daily financial reconciliation (§6, Phase 5).
 *
 * Answers one question a regulator or an auditor will certainly ask: does the
 * money we say we hold match the money that actually moved?
 *
 * Three independent checks, because a single reconciliation that passes tells
 * you less than three narrow ones that can each fail for a different reason:
 *
 *   1. Ledger internal consistency — every transaction balances to zero.
 *   2. Wallet cache integrity      — cached balances replay from the ledger.
 *   3. Provider settlement match   — our record of a deposit or payout agrees
 *                                    with the provider's own report.
 *
 * (1) and (2) are enforced live by constraints and triggers; running them
 * again here is deliberate belt-and-braces. A constraint that has been
 * dropped, disabled, or worked around by a migration fails silently, and this
 * is the job that notices.
 */

export interface UnbalancedTransaction {
  transactionId: string;
  type: string;
  debitsMinor: string;
  creditsMinor: string;
  createdAt: string;
}

export interface WalletDrift {
  walletId: string;
  userId: string | null;
  cachedMinor: string;
  ledgerMinor: string;
  driftMinor: string;
}

export interface ProviderMismatch {
  providerRef: string;
  kind: "MISSING_LOCALLY" | "MISSING_AT_PROVIDER" | "AMOUNT_DIFFERS";
  ourAmountMinor: string | null;
  theirAmountMinor: string | null;
}

/** One line per settled item from a provider's own report. */
export interface ProviderSettlementLine {
  providerRef: string;
  amountMinor: bigint;
  status: "SUCCESS" | "FAILED";
}

export interface ReconciliationReport {
  ranAt: string;
  unbalancedTransactions: UnbalancedTransaction[];
  walletDrift: WalletDrift[];
  /** True only when every check passed. */
  clean: boolean;
}

export class ReconciliationService {
  /**
   * Transactions whose legs do not sum to zero.
   *
   * A deferred constraint trigger already rejects these at commit, so a
   * non-empty result means the trigger is missing or was bypassed — which is
   * a far more serious finding than the imbalance itself.
   */
  async unbalancedTransactions(): Promise<UnbalancedTransaction[]> {
    const rows = await db.execute<{
      txn_id: string;
      type: string;
      debits: string;
      credits: string;
      created_at: Date;
    }>(sql`
      SELECT
        lt.id::text AS txn_id,
        lt.type::text AS type,
        COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'DEBIT'), 0)::text  AS debits,
        COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'CREDIT'), 0)::text AS credits,
        lt.created_at
      FROM ledger_transactions lt
      JOIN ledger_entries le ON le.txn_id = lt.id
      GROUP BY lt.id, lt.type, lt.created_at
      HAVING COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'DEBIT'), 0)
          <> COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'CREDIT'), 0)
      LIMIT 500
    `);

    return rows.map((row) => ({
      transactionId: row.txn_id,
      type: row.type,
      debitsMinor: row.debits,
      creditsMinor: row.credits,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  /**
   * User wallets whose cached balance disagrees with a full ledger replay.
   *
   * The cached balance exists only as a read optimisation; the ledger is the
   * truth. Any drift means the cache was written outside the wallet service,
   * and the wallet should be frozen rather than trusted.
   */
  async walletDrift(): Promise<WalletDrift[]> {
    const rows = await db.execute<{
      wallet_id: string;
      user_id: string | null;
      cached: string;
      ledger: string;
      drift: string;
    }>(sql`
      SELECT
        w.id::text AS wallet_id,
        w.user_id::text AS user_id,
        w.cached_balance_minor::text AS cached,
        COALESCE(SUM(
          CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor ELSE -le.amount_minor END
        ), 0)::text AS ledger,
        (w.cached_balance_minor - COALESCE(SUM(
          CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor ELSE -le.amount_minor END
        ), 0))::text AS drift
      FROM wallets w
      LEFT JOIN ledger_entries le ON le.wallet_id = w.id
      WHERE w.kind = 'USER'
      GROUP BY w.id, w.user_id, w.cached_balance_minor
      HAVING w.cached_balance_minor <> COALESCE(SUM(
        CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor ELSE -le.amount_minor END
      ), 0)
      LIMIT 500
    `);

    return rows.map((row) => ({
      walletId: row.wallet_id,
      userId: row.user_id,
      cachedMinor: row.cached,
      ledgerMinor: row.ledger,
      driftMinor: row.drift,
    }));
  }

  /**
   * Compares a provider's settlement report against our deposits.
   *
   * Three failure shapes, each meaning something different:
   *
   *   MISSING_LOCALLY     — they took the money and we never credited it.
   *                         The customer is short. This is the urgent one.
   *   MISSING_AT_PROVIDER — we credited money they have no record of.
   *                         Either a test transaction or a real hole.
   *   AMOUNT_DIFFERS      — both sides recorded it, for different sums.
   *
   * Only SUCCESS lines are expected to exist locally; a failed charge that we
   * never credited is correct behaviour, not a discrepancy.
   */
  async matchProviderReport(
    provider: string,
    lines: ProviderSettlementLine[],
    range: { from: Date; to: Date },
  ): Promise<ProviderMismatch[]> {
    const ours = await db.execute<{ provider_ref: string; amount_minor: string; status: string }>(sql`
      SELECT provider_ref, amount_minor::text, status::text AS status
      FROM payment_intents
      WHERE provider = ${provider}
        AND created_at >= ${range.from.toISOString()}::timestamptz
        AND created_at <  ${range.to.toISOString()}::timestamptz
    `);

    const ourSucceeded = new Map(
      ours.filter((row) => row.status === "SUCCEEDED").map((row) => [row.provider_ref, row.amount_minor]),
    );
    const theirSucceeded = new Map(
      lines.filter((line) => line.status === "SUCCESS").map((line) => [line.providerRef, line.amountMinor]),
    );

    const mismatches: ProviderMismatch[] = [];

    for (const [ref, theirAmount] of theirSucceeded) {
      const ourAmount = ourSucceeded.get(ref);
      if (ourAmount === undefined) {
        mismatches.push({
          providerRef: ref,
          kind: "MISSING_LOCALLY",
          ourAmountMinor: null,
          theirAmountMinor: theirAmount.toString(),
        });
      } else if (BigInt(ourAmount) !== theirAmount) {
        mismatches.push({
          providerRef: ref,
          kind: "AMOUNT_DIFFERS",
          ourAmountMinor: ourAmount,
          theirAmountMinor: theirAmount.toString(),
        });
      }
    }

    for (const [ref, ourAmount] of ourSucceeded) {
      if (!theirSucceeded.has(ref)) {
        mismatches.push({
          providerRef: ref,
          kind: "MISSING_AT_PROVIDER",
          ourAmountMinor: ourAmount,
          theirAmountMinor: null,
        });
      }
    }

    return mismatches;
  }

  /** Runs the internal checks. Provider matching needs a report to compare. */
  async runDaily(): Promise<ReconciliationReport> {
    const [unbalanced, drift] = await Promise.all([
      this.unbalancedTransactions(),
      this.walletDrift(),
    ]);

    return {
      ranAt: new Date().toISOString(),
      unbalancedTransactions: unbalanced,
      walletDrift: drift,
      clean: unbalanced.length === 0 && drift.length === 0,
    };
  }
}

export const reconciliationService = new ReconciliationService();
