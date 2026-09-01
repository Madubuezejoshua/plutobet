/**
 * Executes every admin page query against the real database.
 *
 * `tsc` validates the TypeScript around a query and nothing inside the
 * template literal, so a wrong column name typechecks perfectly and then 500s
 * the page in front of an administrator. Two such mistakes were already found
 * this way (balance_minor and last_reconciled_at, both actually named
 * something else), which is the argument for running this rather than reading
 * harder.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

type Check = { page: string; run: () => Promise<unknown> };

const checks: Check[] = [
  {
    page: "bets",
    run: () =>
      db.execute(sql`
        SELECT b.id::text, u.email, b.stake_minor::text, b.potential_return_minor::text,
               b.status::text, b.slip_id::text, b.combination_index, b.cashed_out_stake_minor::text,
               b.placed_at, b.settled_at, count(l.id)::int AS leg_count,
               count(l.id) FILTER (WHERE l.result = 'WON')::int AS won_legs,
               count(l.id) FILTER (WHERE l.result = 'PENDING')::int AS pending_legs
        FROM bets b JOIN users u ON u.id = b.user_id
        LEFT JOIN bet_legs l ON l.bet_id = b.id
        GROUP BY b.id, u.email ORDER BY b.placed_at DESC LIMIT 5`),
  },
  {
    page: "bets/totals",
    run: () =>
      db.execute(sql`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
               COALESCE(sum(stake_minor),0)::text AS staked,
               COALESCE(sum(potential_return_minor) FILTER (WHERE status='PENDING'),0)::text AS liability
        FROM bets`),
  },
  {
    page: "ledger",
    run: () =>
      db.execute(sql`
        SELECT t.id::text, t.type::text, t.created_at, t.metadata, count(e.id)::int AS entry_count,
               COALESCE(sum(e.amount_minor) FILTER (WHERE e.direction='DEBIT'),0)::text AS total_minor,
               COALESCE(string_agg(DISTINCT w.kind::text, ', ') FILTER (WHERE e.direction='DEBIT'),'') AS debit_accounts,
               COALESCE(string_agg(DISTINCT w.kind::text, ', ') FILTER (WHERE e.direction='CREDIT'),'') AS credit_accounts
        FROM ledger_transactions t JOIN ledger_entries e ON e.txn_id=t.id
        JOIN wallets w ON w.id=e.wallet_id GROUP BY t.id ORDER BY t.created_at DESC LIMIT 5`),
  },
  {
    page: "events",
    run: () =>
      db.execute(sql`
        SELECT e.id::text, e.sport, e.league, e.home, e.away, e.starts_at, e.status::text,
               count(DISTINCT m.id)::int AS market_count, count(DISTINCT s.id)::int AS selection_count,
               count(DISTINCT b.id) FILTER (WHERE b.status='PENDING')::int AS pending_bets,
               EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = e.id) AS has_result,
               max(s.updated_at) AS newest_price
        FROM events e LEFT JOIN markets m ON m.event_id=e.id
        LEFT JOIN selections s ON s.market_id=m.id
        LEFT JOIN bet_legs l ON l.selection_id=s.id
        LEFT JOIN bets b ON b.id=l.bet_id GROUP BY e.id ORDER BY e.starts_at DESC LIMIT 5`),
  },
  {
    page: "events/stalled",
    run: () =>
      db.execute(sql`
        SELECT count(*) FILTER (
          WHERE status IN ('PENDING','LIVE') AND starts_at < now() - INTERVAL '6 hours'
            AND NOT EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = events.id)
        )::int AS stalled FROM events`),
  },
  {
    page: "reconciliation/wallets",
    run: () =>
      db.execute(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE reconciliation_status='FLAGGED')::int AS flagged,
               count(*) FILTER (WHERE reconciliation_checked_at IS NOT NULL)::int AS checked
        FROM wallets`),
  },
  {
    page: "reconciliation/flagged",
    run: () =>
      db.execute(sql`
        SELECT w.id::text, w.kind::text, w.bucket::text, u.email,
               w.cached_balance_minor::text AS balance_minor
        FROM wallets w LEFT JOIN users u ON u.id = w.user_id
        WHERE w.reconciliation_status='FLAGGED' LIMIT 5`),
  },
  {
    page: "responsible/exclusions",
    run: () =>
      db.execute(sql`
        SELECT count(*) FILTER (WHERE until IS NULL OR until > now())::int AS active,
               count(*) FILTER (WHERE until IS NOT NULL AND until <= now())::int AS expired,
               count(*) FILTER (WHERE until IS NULL)::int AS permanent,
               min(until) FILTER (WHERE until > now()) AS next_expiry
        FROM self_exclusions`),
  },
  {
    page: "responsible/limits",
    run: () =>
      db.execute(sql`
        SELECT type::text, count(*)::int AS n, COALESCE(sum(amount_minor),0)::text AS total_minor,
               COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_minor)::bigint,0)::text AS median_minor
        FROM rg_limits GROUP BY type`),
  },
  {
    page: "compliance/tiers",
    run: () =>
      db.execute(sql`
        SELECT count(*) FILTER (WHERE kyc_level=0)::int AS tier0,
               count(*) FILTER (WHERE kyc_level=1)::int AS tier1,
               count(*) FILTER (WHERE kyc_level>=2)::int AS tier2,
               count(*) FILTER (WHERE date_of_birth IS NULL)::int AS no_dob,
               count(*)::int AS total FROM users`),
  },
  {
    page: "compliance/kyc",
    run: () => db.execute(sql`SELECT status::text, count(*)::int AS n FROM kyc_records GROUP BY status`),
  },
  {
    page: "compliance/stale",
    run: () =>
      db.execute(sql`
        SELECT count(*)::int AS n FROM kyc_records
        WHERE status='PENDING' AND document_key IS NOT NULL
          AND created_at < now() - INTERVAL '48 hours'`),
  },
  {
    page: "compliance/large",
    run: () =>
      db.execute(sql`
        SELECT t.id::text, u.email, t.type::text, e.amount_minor::text, t.created_at
        FROM ledger_transactions t JOIN ledger_entries e ON e.txn_id=t.id
        JOIN wallets w ON w.id=e.wallet_id JOIN users u ON u.id=w.user_id
        WHERE t.type IN ('DEPOSIT','WITHDRAWAL') AND e.amount_minor >= 100000000
        ORDER BY t.created_at DESC LIMIT 5`),
  },
  {
    page: "promotions",
    run: () =>
      db.execute(sql`
        SELECT p.id::text, p.code, p.name, p.kind::text, count(DISTINCT c.id)::int AS claims,
               COALESCE(sum(b.granted_minor),0)::text AS granted_minor
        FROM promotions p LEFT JOIN promotion_claims c ON c.promotion_id=p.id
        LEFT JOIN bonuses b ON b.promotion_id=p.id GROUP BY p.id LIMIT 5`),
  },
  {
    page: "promotions/bonus",
    run: () =>
      db.execute(sql`
        SELECT count(*) FILTER (WHERE status='ACTIVE')::int AS active,
               COALESCE(sum(granted_minor),0)::text AS granted,
               COALESCE(sum(granted_minor) FILTER (WHERE status='ACTIVE'),0)::text AS outstanding,
               COALESCE(sum(wagered_minor),0)::text AS wagered FROM bonuses`),
  },
  {
    page: "casino/catalogue",
    run: () =>
      db.execute(sql`
        SELECT (SELECT count(*)::int FROM casino_providers) AS providers,
               (SELECT count(*)::int FROM casino_games) AS games,
               (SELECT count(*)::int FROM casino_providers WHERE active) AS live_providers`),
  },
  {
    page: "casino/rounds",
    run: () =>
      db.execute(sql`
        SELECT count(*)::int AS total, COALESCE(sum(stake_minor),0)::text AS staked,
               COALESCE(sum(payout_minor),0)::text AS paid FROM game_rounds`),
  },
  {
    page: "casino/recent",
    run: () =>
      db.execute(sql`
        SELECT r.id::text, u.email, r.provider, r.game, r.stake_minor::text,
               r.payout_minor::text, r.status::text, r.created_at
        FROM game_rounds r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 5`),
  },
];

async function main() {
  let failed = 0;
  for (const check of checks) {
    try {
      const rows = (await check.run()) as unknown[];
      console.log(`  ok    ${check.page.padEnd(26)} ${rows.length} row(s)`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      // The driver puts the useful part on the first line and the full SQL
      // after it; printing the lot makes eighteen results unreadable.
      const firstLine = message.split("\n")[0] ?? message;
      console.log(`  FAIL  ${check.page.padEnd(26)} ${firstLine.slice(0, 90)}`);
    }
  }
  console.log(failed === 0 ? "\nAll admin queries run clean." : `\n${failed} FAILING QUERIES`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
