/**
 * Runs the REAL settlement chain once, by hand, in the order Inngest would.
 *
 *   npx tsx scripts/qa-settle-run.ts
 *
 * Exists because the Inngest worker is not running locally and the deployed
 * environment has no database, so the cron that normally drives this has never
 * executed. This is not a shortcut around settlement — it calls exactly the
 * same three services `pollMatchResults`, `settleEvent` and `settleBet` call:
 *
 *   ResultIngestionService.pollFinishedEvents()   ingest the provider result
 *   settlementService.findPendingBetIds(eventId)  find what is riding on it
 *   settlementService.settleBet(betId)            settle and move money
 *   settlementService.closeEventMarkets(eventId)  stop further placement
 *
 * NO BET STATUS IS WRITTEN HERE. The outcome comes from the provider's
 * regulation score via the production resolver.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { OddsApiIoProvider } from "@/modules/odds/odds-api-io";
import { ResultIngestionService } from "@/modules/settlement/ingestion.service";
import { settlementService } from "@/modules/settlement/settlement.service";

async function main() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("ODDS_API_KEY is required");

  console.log("1. pollFinishedEvents() — ingest results from the real provider");
  const ingestion = new ResultIngestionService(new OddsApiIoProvider(apiKey));
  const finished = await ingestion.pollFinishedEvents();
  console.log(`   events with a recorded result: ${finished.length}`);
  for (const item of finished) {
    console.log(`   - ${item.eventId}${item.cancelled ? " (cancelled)" : ""}`);
  }

  if (finished.length === 0) {
    console.log("\nNothing became settleable this run.");
    process.exit(0);
  }

  console.log("\n2. settleBet() for every pending bet on those events");
  let settled = 0;
  for (const item of finished) {
    const betIds = await settlementService.findPendingBetIds(item.eventId);
    for (const betId of betIds) {
      const outcome = await settlementService.settleBet(betId);
      settled += 1;
      console.log(`   ${betId} -> ${JSON.stringify(outcome)}`);
    }
    await settlementService.closeEventMarkets(item.eventId, item.cancelled);
  }
  console.log(`   bets settled: ${settled}`);

  console.log("\n3. Resulting ledger position");
  const rows = await db.execute<{
    email: string;
    bucket: string;
    balance: string;
  }>(sql`
    SELECT u.email, w.bucket::text, w.cached_balance_minor::text AS balance
    FROM wallets w JOIN users u ON u.id = w.user_id
    WHERE u.email LIKE 'qa-http-%' AND w.bucket = 'CASH'
  `);
  rows.forEach((r) => console.log(`   ${r.email}  ${r.bucket}=${r.balance}`));

  const [balance] = await db.execute<{ d: string; c: string }>(sql`
    SELECT coalesce(sum(amount_minor) FILTER (WHERE direction='DEBIT'),0)::text AS d,
           coalesce(sum(amount_minor) FILTER (WHERE direction='CREDIT'),0)::text AS c
    FROM ledger_entries
  `);
  console.log(`   ledger debits ${balance?.d} / credits ${balance?.c} ${balance?.d === balance?.c ? "(BALANCED)" : "(IMBALANCED)"}`);

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("qa-settle-run failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
