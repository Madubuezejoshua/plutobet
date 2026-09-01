/**
 * Phase 5 evidence: runs the REAL odds sync against the REAL provider.
 *
 *   npx tsx scripts/qa-odds-sync.ts
 *
 * Uses the production OddsSyncService and OddsApiIoProvider, not a stub, so
 * what it proves is what the scheduled Inngest job would do. Prints only
 * counts and shapes — never the API key, and never a full payload.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { OddsApiIoProvider } from "@/modules/odds/odds-api-io";
import { OddsSyncService } from "@/modules/odds/sync.service";

const BOOKMAKERS = (process.env.QA_BOOKMAKERS ?? "1xbet")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);

async function main() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("ODDS_API_KEY is required");

  const provider = new OddsApiIoProvider(apiKey);
  const service = new OddsSyncService(provider, { sport: "football", bookmakers: BOOKMAKERS });

  console.log(`bookmakers requested: ${BOOKMAKERS.join(", ")}`);

  // Fixture ingestion is the slow half (an upsert plus taxonomy work per
  // event). Once the board is populated, a run that only needs to prove the
  // PRICING path should not pay for it again.
  if (process.env.QA_SKIP_FIXTURES === "true") {
    console.log("\n1. syncFixtures() SKIPPED (QA_SKIP_FIXTURES=true)");
  } else {
    console.log("\n1. syncFixtures() against the live provider");
    const fixtures = await service.syncFixtures();
    console.log(`   upserted: ${fixtures.upserted}`);
  }

  const [stored] = await db.execute<{
    total: number;
    distinct_sports: number;
    bad_sport: number;
    future: number;
  }>(sql`
    SELECT count(*)::int AS total,
           count(DISTINCT sport)::int AS distinct_sports,
           -- The [object Object] regression: a stringified object is truthy
           -- and non-empty, so it survives every null check into the column.
           count(*) FILTER (WHERE sport = '[object Object]')::int AS bad_sport,
           count(*) FILTER (WHERE starts_at > now())::int AS future
    FROM events
  `);
  console.log(`   events stored: ${stored?.total} (${stored?.future} upcoming)`);
  console.log(`   distinct sport values: ${stored?.distinct_sports}`);
  console.log(`   sport = '[object Object]': ${stored?.bad_sport}`);

  const sports = await db.execute<{ sport: string; n: number }>(sql`
    SELECT sport, count(*)::int AS n FROM events GROUP BY sport ORDER BY 2 DESC LIMIT 5
  `);
  console.log(`   sport values: ${sports.map((s) => `${s.sport}(${s.n})`).join(", ")}`);

  console.log("\n2. refreshWatchlist() — price the upcoming board");
  try {
    const refreshed = await service.refreshWatchlist();
    console.log(`   events priced: ${refreshed.events}`);
  } catch (error) {
    console.log(`   FAILED: ${error instanceof Error ? error.message.slice(0, 220) : error}`);
  }

  const [markets] = await db.execute<{
    markets: number;
    selections: number;
    one_x_two: number;
    priced: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM markets) AS markets,
      (SELECT count(*)::int FROM selections) AS selections,
      (SELECT count(*)::int FROM markets WHERE key = '1x2') AS one_x_two,
      (SELECT count(*)::int FROM selections WHERE current_price_decimal > 1) AS priced
  `);
  console.log(`\n3. Persisted market shape`);
  console.log(`   markets: ${markets?.markets} (1x2: ${markets?.one_x_two})`);
  console.log(`   selections: ${markets?.selections} (priced > 1.0: ${markets?.priced})`);

  const byKey = await db.execute<{ key: string; n: number }>(sql`
    SELECT key::text, count(*)::int AS n FROM markets GROUP BY key ORDER BY 2 DESC
  `);
  console.log(`   market keys: ${byKey.map((m) => `${m.key}(${m.n})`).join(", ") || "(none)"}`);

  const sample = await db.execute<{
    home: string;
    away: string;
    league: string;
    starts_at: Date;
    key: string;
    sel: string;
    price: string;
  }>(sql`
    SELECT e.home, e.away, e.league, e.starts_at, m.key::text, s.key AS sel,
           s.current_price_decimal::text AS price
    FROM selections s
    JOIN markets m ON m.id = s.market_id
    JOIN events e ON e.id = m.event_id
    WHERE m.key = '1x2'
    ORDER BY e.starts_at
    LIMIT 6
  `);

  console.log(`\n4. 1x2 MATCH-RESULT MARKET`);
  if (sample.length === 0) {
    console.log("   BLOCKED: no 1x2 market was persisted from the real feed");
  } else {
    for (const row of sample) {
      console.log(
        `   ${row.home} v ${row.away} (${row.league}) ${new Date(row.starts_at).toISOString()} -> ${row.sel} @ ${row.price}`,
      );
    }
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("qa-odds-sync failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
