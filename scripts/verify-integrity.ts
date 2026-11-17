import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Reads the live database and re-checks the invariants the constraints
 * already enforce. Useful after driving the app by hand: it confirms what
 * actually landed rather than what the API said it did.
 */

async function main(): Promise<void> {
  const [counts] = await db.execute<{ bets: number; legs: number; txns: number }>(sql`
    SELECT (SELECT count(*) FROM bets)::int AS bets,
           (SELECT count(*) FROM ledger_entries)::int AS legs,
           (SELECT count(*) FROM ledger_transactions)::int AS txns
  `);
  console.log("bets:", counts!.bets, "| ledger legs:", counts!.legs, "| txns:", counts!.txns);

  const unbalanced = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT lt.id FROM ledger_transactions lt
      JOIN ledger_entries le ON le.txn_id = lt.id
      GROUP BY lt.id
      HAVING COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction='DEBIT'),0)
          <> COALESCE(SUM(le.amount_minor) FILTER (WHERE le.direction='CREDIT'),0)
    ) b
  `);
  const drift = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT w.id FROM wallets w
      LEFT JOIN ledger_entries le ON le.wallet_id = w.id
      WHERE w.kind='USER'
      GROUP BY w.id, w.cached_balance_minor
      HAVING w.cached_balance_minor <> COALESCE(SUM(
        CASE WHEN le.direction='CREDIT' THEN le.amount_minor ELSE -le.amount_minor END),0)
    ) b
  `);
  const exposure = await db.execute<{ market: string; total: string }>(sql`
    SELECT market_id::text AS market, total_liability_minor::text AS total
    FROM exposure WHERE total_liability_minor > 0
  `);
  console.log("unbalanced txns:", unbalanced[0]!.n, "| drifted wallets:", drift[0]!.n);
  console.log("markets carrying liability:", exposure.length,
    exposure.map((e) => `${Number(e.total)/100} NGN`).join(", "));
  process.exit(0);

}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
