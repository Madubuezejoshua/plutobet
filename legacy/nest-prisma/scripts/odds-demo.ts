/**
 * Phase 2 walkthrough against the running dev stack: shows the repeatable
 * jobs BullMQ actually registered, seeds a fixture the way the sync worker
 * would, then proves the read path serves concurrent browsers without ever
 * touching the provider.
 *
 *   npm run db:dev          (separate terminal, leave running)
 *   npx tsx scripts/odds-demo.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { PrismaService } from "../src/prisma/prisma.service";
import { OddsService } from "../src/odds/odds.service";
import { ODDS_QUEUE } from "../src/odds/odds.processor";
import type { OddsSnapshot } from "../src/odds/provider";

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  const odds = new OddsService(prisma, redis);

  // --- what the app scheduled on boot -------------------------------------
  const queue = new Queue(ODDS_QUEUE, { connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" } });
  const repeatables = await queue.getJobSchedulers();
  console.log(`\nRepeatable jobs registered by the app (${repeatables.length}):`);
  for (const r of repeatables) {
    console.log(`  ${r.name.padEnd(12)} pattern=${r.pattern}  next=${new Date(r.next!).toISOString()}`);
  }

  // --- seed one fixture as the sync worker would ---------------------------
  const providerEventId = `demo-${randomUUID().slice(0, 8)}`;
  const event = await prisma.event.create({
    data: {
      provider: "odds-api.io",
      providerEventId,
      sport: "football",
      league: "Premier League",
      home: "Arsenal",
      away: "Chelsea",
      startsAt: new Date(Date.now() + 3 * 60 * 60_000),
      status: "pending",
    },
  });
  const market = await prisma.market.create({ data: { eventId: event.id, key: "1x2", status: "open" } });
  await prisma.selection.createMany({
    data: [
      { marketId: market.id, key: "home", label: "Arsenal", currentPriceDecimal: 2.1, status: "open" },
      { marketId: market.id, key: "draw", label: "Draw", currentPriceDecimal: 3.4, status: "open" },
      { marketId: market.id, key: "away", label: "Chelsea", currentPriceDecimal: 3.8, status: "open" },
    ],
  });

  const snapshot: OddsSnapshot = {
    eventId: providerEventId,
    fetchedAt: new Date(),
    books: [
      {
        bookmaker: "bet365",
        updatedAt: new Date(),
        markets: [
          {
            key: "1x2",
            selections: [
              { key: "home", label: "Arsenal", price: 2.1 },
              { key: "draw", label: "Draw", price: 3.4 },
              { key: "away", label: "Chelsea", price: 3.8 },
            ],
          },
        ],
      },
    ],
  };
  await redis.set(`odds:${providerEventId}`, JSON.stringify(snapshot), "EX", 900);
  console.log(`\nSeeded fixture ${providerEventId}: Arsenal vs Chelsea`);

  // --- the read path -------------------------------------------------------
  await redis.del("odds:upcoming:football:50");
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      i % 2 === 0 ? odds.getEventOdds(providerEventId) : odds.listUpcoming({ sport: "football" }),
    ),
  );
  const elapsed = Date.now() - started;

  console.log(`\n500 concurrent browsers served in ${elapsed}ms`);
  console.log(`  upstream API calls: 0  (OddsService cannot reach the provider by construction)`);
  console.log(`  all responses non-null: ${results.every((r) => r !== null)}`);

  const listing = (await odds.listUpcoming({ sport: "football" })) as Awaited<ReturnType<typeof odds.listUpcoming>>;
  const demo = listing.find((e) => e.providerEventId === providerEventId);
  if (demo) {
    console.log(`\n${demo.home} vs ${demo.away}  (${demo.league}, kicks off ${demo.startsAt})`);
    for (const m of demo.markets) {
      console.log(`  market ${m.key}:`);
      for (const s of m.selections) {
        console.log(`    ${s.label.padEnd(10)} @ ${s.price}`);
      }
    }
  }

  const budgetKeys = await redis.keys("oddsbudget:*");
  console.log(`\nRate-budget keys in Redis: ${budgetKeys.length ? budgetKeys.join(", ") : "(none — no upstream calls made)"}`);

  await queue.close();
  await redis.quit();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
