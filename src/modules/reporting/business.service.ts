import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Business reporting.
 *
 * Everything is derived from the LEDGER, not from a metrics table. A figure
 * shown to an operator — or handed to a regulator — reconciles against the
 * transaction record, because it IS the transaction record.
 *
 * A cached aggregate would be faster and would eventually disagree with the
 * books, and the day it did nobody would know which number was wrong.
 */

export interface RevenueBreakdown {
  /** Money staked. Turnover, not revenue. */
  stakesMinor: bigint;
  /** Money paid out on wins. */
  payoutsMinor: bigint;
  /** Stakes less payouts. The figure duty is normally assessed on. */
  grossGamingRevenueMinor: bigint;
  /** Bonus credit granted. A cost, not revenue. */
  bonusCostMinor: bigint;
  /** GGR less bonus cost. What the business actually kept. */
  netRevenueMinor: bigint;
}

export interface ProductBreakdown extends RevenueBreakdown {
  product: "SPORTS" | "CASINO" | "JACKPOT";
}

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Revenue split by product.
 *
 * Products are distinguished by ledger metadata rather than separate tables,
 * because every product moves money through the same ledger by design — which
 * is what makes them comparable at all.
 *
 * GGR is stakes minus payouts. Deposits and withdrawals are deliberately
 * excluded: money entering a wallet is not revenue, and counting it as such is
 * the most common way a gambling P&L is overstated.
 */
export async function revenueByProduct(range: DateRange): Promise<ProductBreakdown[]> {
  const rows = await db.execute<{
    product: string;
    stakes: string;
    payouts: string;
    bonus: string;
  }>(sql`
    SELECT
      CASE
        WHEN t.metadata ->> 'kind' LIKE 'CASINO%' THEN 'CASINO'
        WHEN t.metadata ->> 'kind' LIKE 'JACKPOT%' THEN 'JACKPOT'
        ELSE 'SPORTS'
      END AS product,
      COALESCE(SUM(e.amount_minor) FILTER (
        WHERE t.type = 'STAKE' AND e.direction = 'DEBIT'), 0)::text AS stakes,
      COALESCE(SUM(e.amount_minor) FILTER (
        WHERE t.type = 'PAYOUT' AND e.direction = 'CREDIT'), 0)::text AS payouts,
      COALESCE(SUM(e.amount_minor) FILTER (
        WHERE t.type = 'BONUS' AND e.direction = 'CREDIT'), 0)::text AS bonus
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.txn_id
    JOIN wallets w ON w.id = e.wallet_id
    WHERE w.kind = 'USER'
      AND t.created_at >= ${range.from.toISOString()}::timestamptz
      AND t.created_at < ${range.to.toISOString()}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `);

  return rows.map((row) => {
    const stakesMinor = BigInt(row.stakes);
    const payoutsMinor = BigInt(row.payouts);
    const bonusCostMinor = BigInt(row.bonus);
    const grossGamingRevenueMinor = stakesMinor - payoutsMinor;

    return {
      product: row.product as ProductBreakdown["product"],
      stakesMinor,
      payoutsMinor,
      grossGamingRevenueMinor,
      bonusCostMinor,
      netRevenueMinor: grossGamingRevenueMinor - bonusCostMinor,
    };
  });
}

export interface CustomerMetrics {
  registered: number;
  /** Placed at least one bet in the window. */
  active: number;
  /** Registered AND first bet in the window. */
  newlyActive: number;
  depositingCustomers: number;
}

export async function customerMetrics(range: DateRange): Promise<CustomerMetrics> {
  const [row] = await db.execute<{
    registered: number;
    active: number;
    newly_active: number;
    depositing: number;
  }>(sql`
    WITH window_bets AS (
      SELECT DISTINCT user_id FROM bets
      WHERE placed_at >= ${range.from.toISOString()}::timestamptz
        AND placed_at < ${range.to.toISOString()}::timestamptz
    ),
    window_deposits AS (
      SELECT DISTINCT w.user_id
      FROM ledger_entries e
      JOIN ledger_transactions t ON t.id = e.txn_id
      JOIN wallets w ON w.id = e.wallet_id
      WHERE t.type = 'DEPOSIT' AND e.direction = 'CREDIT' AND w.kind = 'USER'
        AND t.created_at >= ${range.from.toISOString()}::timestamptz
        AND t.created_at < ${range.to.toISOString()}::timestamptz
    )
    SELECT
      (SELECT count(*) FROM users
        WHERE created_at >= ${range.from.toISOString()}::timestamptz
          AND created_at < ${range.to.toISOString()}::timestamptz)::int AS registered,
      (SELECT count(*) FROM window_bets)::int AS active,
      (SELECT count(*) FROM window_bets wb
        JOIN users u ON u.id = wb.user_id
        WHERE u.created_at >= ${range.from.toISOString()}::timestamptz)::int AS newly_active,
      (SELECT count(*) FROM window_deposits)::int AS depositing
  `);

  return {
    registered: Number(row?.registered ?? 0),
    active: Number(row?.active ?? 0),
    newlyActive: Number(row?.newly_active ?? 0),
    depositingCustomers: Number(row?.depositing ?? 0),
  };
}

export type HealthState = "OK" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface SubsystemAlert {
  subsystem: string;
  state: HealthState;
  detail: string;
}

/**
 * Conditions that should wake somebody.
 *
 * Each is a fact the database can answer, not a guess. Deliberately narrow:
 * an alert list that fires often is one operators learn to ignore, and then it
 * is worth nothing on the night it matters.
 */
export async function operationalAlerts(): Promise<SubsystemAlert[]> {
  const alerts: SubsystemAlert[] = [];

  const [wallets] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM wallets WHERE reconciliation_status = 'FLAGGED'
  `);
  if (Number(wallets?.n ?? 0) > 0) {
    alerts.push({
      subsystem: "Ledger",
      // Money the books cannot explain. Nothing else here outranks it.
      state: "DOWN",
      detail: `${wallets!.n} wallets have drifted from their ledger`,
    });
  }

  const [payouts] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM withdrawals
    WHERE status = 'PROCESSING' AND updated_at < now() - INTERVAL '2 hours'
  `);
  if (Number(payouts?.n ?? 0) > 0) {
    alerts.push({
      subsystem: "Payouts",
      state: "DEGRADED",
      detail: `${payouts!.n} withdrawals stuck in processing for over two hours`,
    });
  }

  const [kyc] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM kyc_records
    WHERE status = 'PENDING' AND document_key IS NOT NULL
      AND created_at < now() - INTERVAL '48 hours'
  `);
  if (Number(kyc?.n ?? 0) > 0) {
    alerts.push({
      subsystem: "Verification",
      state: "DEGRADED",
      // A customer waiting two days to verify is a customer who cannot
      // withdraw their own money.
      detail: `${kyc!.n} verification documents unreviewed for over 48 hours`,
    });
  }

  const [odds] = await db.execute<{ newest: Date | null }>(sql`
    SELECT max(updated_at) AS newest FROM selections
  `);
  if (odds?.newest) {
    const minutesStale = (Date.now() - new Date(odds.newest).getTime()) / 60_000;
    if (minutesStale > 60) {
      alerts.push({
        subsystem: "Odds feed",
        state: "DOWN",
        detail: `No price has moved in ${Math.round(minutesStale)} minutes`,
      });
    }
  }

  /*
   * Matches that finished long ago and still have no result.
   *
   * This is the alarm for a SILENT settlement stall. Ingestion refuses to
   * record a finished match with no `periods.ft` — correctly, since settling
   * without a regulation score would pay against a number that is not there.
   * But refusing is invisible: the poll keeps running, throws nothing, and the
   * bets simply stay PENDING.
   *
   * That is the exact failure mode of an upstream shape change, and it is the
   * one nobody notices until customers ask where their winnings are. The poll
   * runs every minute and assumes a match is over after three hours, so six
   * hours without a result means the pipeline is stuck, not merely slow.
   */
  const [stalled] = await db.execute<{ n: number; oldest: Date | null }>(sql`
    SELECT count(*)::int AS n, min(e.starts_at) AS oldest
    FROM events e
    WHERE e.status IN ('PENDING', 'LIVE')
      AND e.starts_at < now() - INTERVAL '6 hours'
      AND NOT EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = e.id)
      AND EXISTS (
        SELECT 1
        FROM bet_legs l
        JOIN bets b ON b.id = l.bet_id
        JOIN selections s ON s.id = l.selection_id
        JOIN markets m ON m.id = s.market_id
        WHERE m.event_id = e.id AND b.status = 'PENDING'
      )
  `);
  if (Number(stalled?.n ?? 0) > 0) {
    const hours = stalled?.oldest
      ? Math.round((Date.now() - new Date(stalled.oldest).getTime()) / 3_600_000)
      : 0;
    alerts.push({
      subsystem: "Settlement",
      // Customers have staked money on these and cannot be paid. Only a
      // divergent ledger outranks it.
      state: "DOWN",
      detail:
        `${stalled!.n} finished matches with pending bets have no result` +
        (hours ? ` — the oldest ended ${hours} hours ago` : "") +
        ". Check the provider response shape.",
    });
  }

  if (!process.env.PAYSTACK_SECRET_KEY) {
    alerts.push({
      subsystem: "Payments",
      state: "DOWN",
      detail: "No payment credentials configured; deposits and withdrawals cannot run",
    });
  }

  return alerts;
}
