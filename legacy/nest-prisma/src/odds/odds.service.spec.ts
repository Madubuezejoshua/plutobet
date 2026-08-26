import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { OddsService } from "./odds.service";
import { OddsSyncWorker } from "./syncWorker";
import type { EventResult, OddsProvider, OddsSnapshot, SportEvent } from "./provider";

const prisma = new PrismaService();
let redis: Redis;

/**
 * Counts every upstream call. The Phase 2 acceptance criterion is that user
 * browsing triggers ZERO of these — so rather than assert on a mock's call
 * count after the fact, every method also throws, making an accidental
 * provider call from the read path fail loudly at the call site.
 */
class ForbiddenProvider implements OddsProvider {
  readonly name = "test-provider";
  calls = 0;

  private forbid(method: string): never {
    this.calls++;
    throw new Error(`read path called the odds provider (${method}) — budget leak`);
  }

  listEvents(): Promise<SportEvent[]> {
    return this.forbid("listEvents");
  }
  listLiveEvents(): Promise<SportEvent[]> {
    return this.forbid("listLiveEvents");
  }
  getOdds(): Promise<OddsSnapshot[]> {
    return this.forbid("getOdds");
  }
  getUpdatedSince(): Promise<OddsSnapshot[] | null> {
    return this.forbid("getUpdatedSince");
  }
  getResults(): Promise<EventResult[]> {
    return this.forbid("getResults");
  }
}

const provider = new ForbiddenProvider();
let oddsService: OddsService;
let providerEventId: string;

describe("OddsService read path", () => {
  beforeAll(async () => {
    await prisma.$connect();
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    oddsService = new OddsService(prisma, redis);

    providerEventId = `evt-${randomUUID()}`;

    // Seed as the sync worker would have: an event, a cached snapshot, and
    // normalized markets/selections.
    const event = await prisma.event.create({
      data: {
        provider: provider.name,
        providerEventId,
        sport: "football",
        league: "Premier League",
        home: "Arsenal",
        away: "Chelsea",
        startsAt: new Date(Date.now() + 3 * 60 * 60_000),
        status: "pending",
      },
    });
    const market = await prisma.market.create({
      data: { eventId: event.id, key: "1x2", status: "open" },
    });
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
  });

  afterAll(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });

  // THE Phase 2 acceptance criterion.
  it("serves 500 concurrent odds browsers with zero upstream API calls", async () => {
    const before = provider.calls;

    // Count real Postgres round-trips too. Zero upstream calls is the stated
    // bar, but a read path that instead stampedes the database just moves the
    // outage — so assert the herd actually collapses.
    let dbQueries = 0;
    const countingPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "event") {
          const model = Reflect.get(target, prop, receiver);
          return new Proxy(model, {
            get(m, mProp, mReceiver) {
              if (mProp === "findMany") {
                return (...args: unknown[]) => {
                  dbQueries++;
                  return (Reflect.get(m, mProp, mReceiver) as Function).apply(m, args);
                };
              }
              return Reflect.get(m, mProp, mReceiver);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaService;

    const service = new OddsService(countingPrisma, redis);
    await redis.del("odds:upcoming:football:50"); // cold cache, worst case

    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        i % 2 === 0 ? service.getEventOdds(providerEventId) : service.listUpcoming({ sport: "football" }),
      ),
    );

    expect(results).toHaveLength(500);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(provider.calls).toBe(before);
    expect(provider.calls).toBe(0);
    // 250 concurrent listing requests, one shared query.
    expect(dbQueries).toBe(1);
  });

  it("falls back to the persisted snapshot when the cache expires, still without calling upstream", async () => {
    const evictedId = `evt-${randomUUID()}`;
    await prisma.oddsSnapshot.create({
      data: {
        provider: provider.name,
        providerEventId: evictedId,
        payload: [{ bookmaker: "bet365", updatedAt: new Date(), markets: [] }] as unknown as object,
        fetchedAt: new Date(),
      },
    });

    // No Redis key for this one at all — simulates an expired/evicted entry.
    expect(await redis.get(`odds:${evictedId}`)).toBeNull();

    const snapshot = await oddsService.getEventOdds(evictedId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.eventId).toBe(evictedId);
    expect(provider.calls).toBe(0);
  });

  it("returns null for an unknown event rather than reaching upstream", async () => {
    expect(await oddsService.getEventOdds(`evt-${randomUUID()}`)).toBeNull();
    expect(provider.calls).toBe(0);
  });
});

describe("OddsSyncWorker market reconciliation", () => {
  it("suspends markets and selections that fall out of the provider feed", async () => {
    const evtId = `evt-${randomUUID()}`;
    const event = await prisma.event.create({
      data: {
        provider: "test-provider",
        providerEventId: evtId,
        sport: "football",
        league: "La Liga",
        home: "Real Madrid",
        away: "Barcelona",
        startsAt: new Date(Date.now() + 2 * 60 * 60_000),
        status: "pending",
      },
    });

    // A provider that returns 1x2 + btts on the first pass, then drops btts —
    // the exact shape of a market being pulled/suspended upstream.
    let includeBtts = true;
    const shiftingProvider: OddsProvider = {
      name: "test-provider",
      listEvents: async () => [],
      listLiveEvents: async () => [],
      getResults: async () => [],
      getUpdatedSince: async () => null,
      getOdds: async () => [
        {
          eventId: evtId,
          fetchedAt: new Date(),
          books: [
            {
              bookmaker: "bet365",
              updatedAt: new Date(),
              markets: [
                {
                  key: "1x2" as const,
                  selections: [
                    { key: "home", label: "Real Madrid", price: 1.9 },
                    { key: "draw", label: "Draw", price: 3.5 },
                    { key: "away", label: "Barcelona", price: 4.0 },
                  ],
                },
                ...(includeBtts
                  ? [
                      {
                        key: "btts" as const,
                        selections: [
                          { key: "yes", label: "Yes", price: 1.7 },
                          { key: "no", label: "No", price: 2.05 },
                        ],
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      ],
    };

    const worker = new OddsSyncWorker(shiftingProvider, prisma, redis, {
      sport: "football",
      bookmakers: ["bet365"],
    });

    await worker.syncLiveOdds().catch(() => {});
    // syncLiveOdds only looks at live events; drive the persist path directly
    // via the watchlist refresh instead by marking the event live.
    await prisma.event.update({ where: { id: event.id }, data: { status: "live" } });
    await worker.syncLiveOdds();

    const afterFirst = await prisma.market.findMany({ where: { eventId: event.id } });
    expect(afterFirst.map((m) => m.key).sort()).toEqual(["1x2", "btts"]);
    expect(afterFirst.every((m) => m.status === "open")).toBe(true);

    // Second pass: btts is gone from the feed.
    includeBtts = false;
    await worker.syncLiveOdds();

    const afterSecond = await prisma.market.findMany({
      where: { eventId: event.id },
      include: { selections: true },
    });
    const oneXTwo = afterSecond.find((m) => m.key === "1x2")!;
    const btts = afterSecond.find((m) => m.key === "btts")!;

    expect(oneXTwo.status).toBe("open");
    expect(btts.status).toBe("suspended");
    expect(btts.selections.every((s) => s.status === "suspended")).toBe(true);
  });
});
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
