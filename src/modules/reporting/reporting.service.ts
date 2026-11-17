import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Regulator and AML reporting exports (§7).
 *
 * Everything is derived from the ledger and the audit trail, never from a
 * separate reporting table kept in step by application code. A figure a
 * regulator can reconcile against the ledger is worth more than a fast one
 * that might silently disagree with it.
 *
 * All money is emitted as an integer string in kobo. Formatting to naira is a
 * presentation choice and a float away from a wrong number in a filing.
 */

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * A `type` alias, not an `interface`, on purpose: drizzle's `db.execute<T>`
 * constrains T to Record<string, unknown>, and TypeScript grants an implicit
 * index signature to type aliases but never to interfaces. Declared as an
 * interface this fails to compile at the call site.
 */
export type TransactionRow = {
  transactionId: string;
  type: string;
  reference: string | null;
  userId: string | null;
  direction: string;
  amountMinor: string;
  balanceAfterMinor: string | null;
  actorType: string;
  createdAt: string;
};

export interface DailyTurnover {
  day: string;
  depositsMinor: string;
  withdrawalsMinor: string;
  stakesMinor: string;
  payoutsMinor: string;
  refundsMinor: string;
  /** stakes - payouts - refunds: what the house actually kept. */
  grossGamingRevenueMinor: string;
}

/** Intersection rather than `extends`, for the same index-signature reason. */
export type LargeTransaction = TransactionRow & {
  email: string | null;
  kycLevel: number | null;
};

export class ReportingService {
  /**
   * Every user-wallet ledger movement in a period.
   *
   * System-wallet legs are excluded: they are the contra side of the same
   * movements and would double every figure in the export.
   */
  async transactions(range: DateRange, limit = 10_000): Promise<TransactionRow[]> {
    const rows = await db.execute<TransactionRow & { created_at: Date }>(sql`
      SELECT
        lt.id::text            AS "transactionId",
        lt.type::text          AS type,
        lt.reference           AS reference,
        w.user_id::text        AS "userId",
        le.direction::text     AS direction,
        le.amount_minor::text  AS "amountMinor",
        le.balance_after_minor::text AS "balanceAfterMinor",
        lt.actor_type::text    AS "actorType",
        le.created_at          AS created_at
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.txn_id
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.kind = 'USER'
        AND le.created_at >= ${range.from.toISOString()}::timestamptz
        AND le.created_at <  ${range.to.toISOString()}::timestamptz
      ORDER BY le.created_at
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      transactionId: row.transactionId,
      type: row.type,
      reference: row.reference,
      userId: row.userId,
      direction: row.direction,
      amountMinor: row.amountMinor,
      balanceAfterMinor: row.balanceAfterMinor,
      actorType: row.actorType,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  /**
   * Daily turnover and gross gaming revenue.
   *
   * GGR is stakes minus payouts minus refunds — the figure gaming duty is
   * normally assessed on. Deposits and withdrawals are reported alongside but
   * are NOT part of it: money moving in and out of a wallet is not revenue,
   * and conflating the two overstates the tax base substantially.
   */
  async dailyTurnover(range: DateRange): Promise<DailyTurnover[]> {
    const rows = await db.execute<{
      day: string;
      deposits: string;
      withdrawals: string;
      stakes: string;
      payouts: string;
      refunds: string;
    }>(sql`
      SELECT
        to_char(date_trunc('day', le.created_at), 'YYYY-MM-DD') AS day,
        COALESCE(SUM(le.amount_minor) FILTER (
          WHERE lt.type = 'DEPOSIT' AND le.direction = 'CREDIT'), 0)::text AS deposits,
        COALESCE(SUM(le.amount_minor) FILTER (
          WHERE lt.type = 'WITHDRAWAL' AND le.direction = 'DEBIT'), 0)::text AS withdrawals,
        COALESCE(SUM(le.amount_minor) FILTER (
          WHERE lt.type = 'STAKE' AND le.direction = 'DEBIT'), 0)::text AS stakes,
        COALESCE(SUM(le.amount_minor) FILTER (
          WHERE lt.type = 'PAYOUT' AND le.direction = 'CREDIT'), 0)::text AS payouts,
        COALESCE(SUM(le.amount_minor) FILTER (
          WHERE lt.type = 'REFUND' AND le.direction = 'CREDIT'), 0)::text AS refunds
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.txn_id
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.kind = 'USER'
        AND le.created_at >= ${range.from.toISOString()}::timestamptz
        AND le.created_at <  ${range.to.toISOString()}::timestamptz
      GROUP BY 1
      ORDER BY 1
    `);

    return rows.map((row) => ({
      day: row.day,
      depositsMinor: row.deposits,
      withdrawalsMinor: row.withdrawals,
      stakesMinor: row.stakes,
      payoutsMinor: row.payouts,
      refundsMinor: row.refunds,
      grossGamingRevenueMinor: (
        BigInt(row.stakes) - BigInt(row.payouts) - BigInt(row.refunds)
      ).toString(),
    }));
  }

  /**
   * Movements at or above a threshold, for AML/SCUML reporting.
   *
   * Defaults to ₦5,000,000 in kobo. The threshold is a parameter because it
   * is set by regulation, not by us, and it changes.
   */
  async largeTransactions(
    range: DateRange,
    thresholdMinor = 500_000_000n,
  ): Promise<LargeTransaction[]> {
    const rows = await db.execute<LargeTransaction & { created_at: Date }>(sql`
      SELECT
        lt.id::text            AS "transactionId",
        lt.type::text          AS type,
        lt.reference           AS reference,
        w.user_id::text        AS "userId",
        le.direction::text     AS direction,
        le.amount_minor::text  AS "amountMinor",
        le.balance_after_minor::text AS "balanceAfterMinor",
        lt.actor_type::text    AS "actorType",
        u.email                AS email,
        u.kyc_level            AS "kycLevel",
        le.created_at          AS created_at
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.txn_id
      JOIN wallets w ON w.id = le.wallet_id
      JOIN users u ON u.id = w.user_id
      WHERE w.kind = 'USER'
        AND lt.type IN ('DEPOSIT', 'WITHDRAWAL')
        AND le.amount_minor >= ${thresholdMinor.toString()}::bigint
        AND le.created_at >= ${range.from.toISOString()}::timestamptz
        AND le.created_at <  ${range.to.toISOString()}::timestamptz
      ORDER BY le.amount_minor DESC
      LIMIT 5000
    `);

    return rows.map((row) => ({
      ...row,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  /**
   * Serialises rows to CSV.
   *
   * Values are quoted and internal quotes doubled — an account name with a
   * comma would otherwise shift every later column in a filing, and nobody
   * reviewing a spreadsheet would notice.
   */
  toCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]!);
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return "";
      return `"${String(value).replace(/"/g, '""')}"`;
    };
    return [
      headers.map(escape).join(","),
      ...rows.map((row) => headers.map((header) => escape(row[header])).join(",")),
    ].join("\n");
  }
}

export const reportingService = new ReportingService();
