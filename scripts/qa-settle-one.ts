/**
 * Settles ONE event through the production services.
 *
 *   npx tsx scripts/qa-settle-one.ts <internalEventId>
 *
 * Same services the Inngest jobs use — the provider adapter for the result,
 * settlementService.ingestResult to record it, settleBet to resolve and pay:
 * no status is written by hand and no score is invented.
 *
 * The ONE thing it skips is `pollFinishedEvents`'s FIFO queue, which takes the
 * 20 oldest unresolved events per tick. Lower-league fixtures that the provider
 * never scores stay in that queue and are re-fetched every run, so a newer
 * event can wait a long time behind them. That is a scheduling property of the
 * poller, not of settlement, and it is recorded as a finding rather than
 * worked around in production code.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { OddsApiIoProvider } from "@/modules/odds/odds-api-io";
import { settlementService } from "@/modules/settlement/settlement.service";

async function main() {
  const eventId = process.argv[2]?.trim();
  const apiKey = process.env.ODDS_API_KEY;
  if (!eventId) throw new Error("usage: qa-settle-one.ts <internalEventId>");
  if (!apiKey) throw new Error("ODDS_API_KEY is required");

  const [event] = await db.execute<{ provider_event_id: string; home: string; away: string }>(sql`
    SELECT provider_event_id, home, away FROM events WHERE id = ${eventId}::uuid
  `);
  if (!event) throw new Error(`no event ${eventId}`);
  console.log(`event: ${event.home} v ${event.away} (provider ${event.provider_event_id})`);

  const provider = new OddsApiIoProvider(apiKey);
  const [result] = await provider.getResults([event.provider_event_id]);
  if (!result) throw new Error("provider returned no result");

  console.log(`provider status: ${result.status}`);
  console.log(`regulation score (periods.ft): ${JSON.stringify(result.periods.ft ?? null)}`);
  if (result.status !== "SETTLED" && result.status !== "CANCELLED") {
    console.log("not settled upstream yet — nothing to do");
    process.exit(0);
  }
  if (result.status === "SETTLED" && !result.periods.ft) {
    console.log("finished but no regulation score — refusing to settle (this is correct)");
    process.exit(0);
  }

  await settlementService.ingestResult({
    eventId,
    provider: provider.name,
    result: {
      status: result.status === "CANCELLED" ? "CANCELLED" : "SETTLED",
      periods: result.periods,
    },
  });
  await db.execute(sql`
    UPDATE events SET status = ${result.status === "CANCELLED" ? "CANCELLED" : "SETTLED"}::event_status,
                      updated_at = now()
    WHERE id = ${eventId}::uuid
  `);
  console.log("result recorded");

  const betIds = await settlementService.findPendingBetIds(eventId);
  console.log(`pending bets on this event: ${betIds.length}`);
  for (const betId of betIds) {
    const outcome = await settlementService.settleBet(betId);
    console.log(`  ${betId} -> ${JSON.stringify(outcome)}`);
  }
  await settlementService.closeEventMarkets(eventId, result.status === "CANCELLED");

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("qa-settle-one failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
