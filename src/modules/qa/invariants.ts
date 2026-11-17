import { sql } from "drizzle-orm";
import { walletService } from "@/modules/wallet/wallet.service";

/**
 * The money invariants, asked of the database directly.
 *
 * These are the questions whose answer must be zero no matter what the
 * application has been asked to do — the ones a test suite cannot establish by
 * asserting its own expectations, because a bug that miscounts will also
 * miscount in the assertion.
 *
 * READ ONLY. Every statement here is a SELECT. Nothing in this file writes,
 * repairs, or reconciles: a checker that fixes what it finds can no longer tell
 * you whether the system was ever broken.
 *
 * Used from two places — `scripts/check-money-invariants.mjs` as a gate, and
 * `/api/qa/invariants` so the settlement browser journey can assert the same
 * numbers at the moment it finishes rather than in a separate run afterwards.
 */

export interface MoneyInvariants {
  /** Ledger transactions whose debits and credits do not agree. */
  unbalancedTransactions: number;
  /** Wallets holding less than nothing. */
  negativeWallets: number;
  /** Bets carrying more than one settlement payout or refund. */
  duplicatePayouts: number;
  /** Wallets whose cached balance disagrees with their entries. */
  cacheDrift: number;
  /** Bets still PENDING on an event that already has a final result. */
  pendingOnFinalEvents: number;
  /** Bets marked WON with no payout transaction against them. */
  wonWithoutPayout: number;
  /** Markets still OPEN on an event that already has a final result. */
  openMarketsOnFinalEvents: number;
  /** Liability still held for a market whose bets are all settled. */
  residualExposureMarkets: number;
  /** Outbox items abandoned after exhausting their attempts. */
  failedOutboxItems: number;
}

export async function moneyInvariants(): Promise<MoneyInvariants> {
  return walletService.withMoneyTransaction(async ({ tx }) => {
    const [row] = await tx.execute<Record<keyof MoneyInvariants, number>>(sql`
      SELECT
        (
          SELECT count(*)::int FROM (
            SELECT le.txn_id
            FROM ledger_entries le
            GROUP BY le.txn_id
            HAVING COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'DEBIT'), 0)
                <> COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'CREDIT'), 0)
          ) AS unbalanced
        ) AS "unbalancedTransactions",

        (SELECT count(*)::int FROM wallets WHERE cached_balance_minor < 0) AS "negativeWallets",

        (
          /*
           * A BET paid twice, not a key used twice.
           *
           * The obvious check — group by idempotency_key, look for a count
           * above one — can never fire: ledger_transactions carries a UNIQUE
           * index on that column, so the database already forbids it and the
           * query would assert a constraint rather than a behaviour. What CAN
           * happen is a bet reaching two DIFFERENT settlement keys, because the
           * key encodes the outcome: 'settlement:won:<bet>' and
           * 'settlement:void:<bet>' are distinct strings for the same bet, and
           * a resettlement that failed to reverse the first one would leave
           * both. That is the duplicate worth counting, so the bet id is
           * extracted from the key and grouped on.
           */
          SELECT COALESCE(SUM(extra), 0)::int FROM (
            SELECT count(*) - 1 AS extra
            FROM ledger_transactions
            WHERE type IN ('PAYOUT', 'REFUND')
              AND idempotency_key LIKE 'settlement:%'
            GROUP BY split_part(idempotency_key, ':', 3)
            HAVING count(*) > 1
          ) AS duplicates
        ) AS "duplicatePayouts",

        (
          SELECT count(*)::int FROM (
            SELECT w.id
            FROM wallets w
            LEFT JOIN ledger_entries le ON le.wallet_id = w.id
            GROUP BY w.id, w.cached_balance_minor
            HAVING w.cached_balance_minor <>
              COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'CREDIT'), 0)
              - COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction = 'DEBIT'), 0)
          ) AS drifted
        ) AS "cacheDrift",

        (
          SELECT count(DISTINCT b.id)::int
          FROM bets b
          JOIN bet_legs bl ON bl.bet_id = b.id
          JOIN selections s ON s.id = bl.selection_id
          JOIN markets m ON m.id = s.market_id
          JOIN event_results r ON r.event_id = m.event_id
          WHERE b.status = 'PENDING'
        ) AS "pendingOnFinalEvents",

        (
          SELECT count(*)::int
          FROM bets b
          WHERE b.status = 'WON'
            AND NOT EXISTS (
              SELECT 1 FROM ledger_transactions lt
              WHERE lt.idempotency_key = 'settlement:won:' || b.id::text
            )
        ) AS "wonWithoutPayout",

        (
          SELECT count(DISTINCT m.id)::int
          FROM markets m
          JOIN event_results r ON r.event_id = m.event_id
          WHERE m.status = 'OPEN'
        ) AS "openMarketsOnFinalEvents",

        (
          SELECT count(*)::int
          FROM exposure e
          WHERE e.total_liability_minor > 0
            AND NOT EXISTS (
              SELECT 1
              FROM bet_legs bl
              JOIN bets b ON b.id = bl.bet_id
              JOIN selections s ON s.id = bl.selection_id
              WHERE s.market_id = e.market_id AND b.status = 'PENDING'
            )
        ) AS "residualExposureMarkets",

        (SELECT count(*)::int FROM settlement_outbox WHERE status = 'FAILED') AS "failedOutboxItems"
    `);
    if (!row) throw new Error("invariant query returned no row");
    return row;
  });
}

/**
 * Every one of them must be zero. There is no second list.
 *
 * `residualExposureMarkets` is here rather than in a softer "watch this"
 * category, and that is deliberate: it is the check that would have caught the
 * ₦630 of liability still held against markets whose bets had all settled long
 * before it became a historical repair somebody has to approve. An invariant
 * that is allowed to be non-zero is not an invariant.
 *
 * `pendingOnFinalEvents` and `openMarketsOnFinalEvents` are transient DURING a
 * settlement run — between ingesting a result and the fan-out completing, both
 * are legitimately above zero. They are asserted after the pipeline has been
 * driven to quiescence, never in the middle of it.
 */
export const MUST_BE_ZERO: (keyof MoneyInvariants)[] = [
  "unbalancedTransactions",
  "negativeWallets",
  "duplicatePayouts",
  "cacheDrift",
  "pendingOnFinalEvents",
  "wonWithoutPayout",
  "openMarketsOnFinalEvents",
  "residualExposureMarkets",
  "failedOutboxItems",
];
