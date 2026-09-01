/**
 * Stage 10: check whether the real QA bet has settled yet.
 *
 *   npx tsx scripts/qa-check-bet.ts <betId>
 *
 * READ-ONLY BY CONSTRUCTION. There is no INSERT, UPDATE or DELETE anywhere in
 * this file, and it never calls a settlement service. It reports what the
 * provider and the settlement engine have done;
 * it never writes a status. A bet is settled by `pollMatchResults` reading the
 * provider's regulation score — manually marking one won or lost would prove
 * nothing except that a human can edit a row.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

async function main() {
  const betId = process.argv[2]?.trim();
  if (!betId) throw new Error("usage: qa-check-bet.ts <betId>");

  const [bet] = await db.execute<{
    status: string;
    stake: string;
    potential: string;
    odds: string;
    placed_at: Date;
    settled_at: Date | null;
    home: string;
    away: string;
    starts_at: Date;
    provider_event_id: string;
    event_status: string;
    sel: string;
    has_result: boolean;
  }>(sql`
    SELECT b.status::text, b.stake_minor::text AS stake,
           b.potential_return_minor::text AS potential,
           l.locked_odds_decimal::text AS odds,
           b.placed_at, b.settled_at,
           e.home, e.away, e.starts_at, e.provider_event_id,
           e.status::text AS event_status, s.key AS sel,
           EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = e.id) AS has_result
    FROM bets b
    JOIN bet_legs l ON l.bet_id = b.id
    JOIN selections s ON s.id = l.selection_id
    JOIN markets m ON m.id = s.market_id
    JOIN events e ON e.id = m.event_id
    WHERE b.id = ${betId}::uuid
  `);

  if (!bet) {
    console.log(`no bet ${betId}`);
    process.exit(1);
  }

  const kickoff = new Date(bet.starts_at);
  const hoursSince = (Date.now() - kickoff.getTime()) / 3_600_000;

  console.log(`bet        : ${betId}`);
  console.log(`event      : ${bet.home} v ${bet.away} (provider ${bet.provider_event_id})`);
  console.log(`kickoff    : ${kickoff.toISOString()}  (${hoursSince.toFixed(1)}h ago)`);
  console.log(`selection  : ${bet.sel} @ ${bet.odds}`);
  console.log(`stake      : ${bet.stake} kobo   potential: ${bet.potential} kobo`);
  console.log(`bet status : ${bet.status}${bet.settled_at ? ` (settled ${new Date(bet.settled_at).toISOString()})` : ""}`);
  console.log(`event      : ${bet.event_status}   result recorded: ${bet.has_result}`);

  const payouts = await db.execute<{ type: string; amount: string }>(sql`
    SELECT t.type::text, e.amount_minor::text AS amount
    FROM ledger_transactions t
    JOIN ledger_entries e ON e.txn_id = t.id
    JOIN wallets w ON w.id = e.wallet_id
    WHERE t.metadata ->> 'betId' = ${betId} AND e.direction = 'CREDIT' AND w.kind = 'USER'
  `);
  console.log(`payouts    : ${payouts.length ? payouts.map((p) => `${p.type} ${p.amount}`).join(", ") : "none"}`);

  if (bet.status === "PENDING" && hoursSince > 6) {
    console.log(
      "\nSTALLED: kickoff was over six hours ago and no result has been recorded.\n" +
        "This is exactly what the Settlement operational alert exists to catch —\n" +
        "check the provider response shape and the pollMatchResults job.",
    );
  } else if (bet.status === "PENDING") {
    console.log("\nStill pending, which is expected until the match finishes and the poller runs.");
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("qa-check-bet failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
