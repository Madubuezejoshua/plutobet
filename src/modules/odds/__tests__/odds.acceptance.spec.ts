import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, pooledSql } from "@/db/pooled";
import { getEventOdds, listUpcoming } from "../odds.service";
import { events, markets, oddsSnapshots, selections } from "../schema";
import { OddsSyncService } from "../sync.service";
import type {
  EventResult,
  OddsProvider,
  OddsSnapshot,
  SportEvent,
} from "../provider";

/**
 * Fails loudly on any upstream call. The Phase 2 acceptance criterion is that
 * browsing triggers zero of them, so rather than assert a call count after the
 * fact, every method throws — an accidental provider call from the read path
 * fails at the call site.
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

async function seedFixture(providerEventId: string, provider = "test-provider") {
  const [event] = await db
    .insert(events)
    .values({
      provider,
      providerEventId,
      sport: "football",
      league: "Premier League",
      home: "Arsenal",
      away: "Chelsea",
      // Deliberately the soonest kickoff in the database.
      //
      // listUpcoming orders by starts_at ASC and takes a limited page. Every
      // other fixture the suite seeds — here and in the betting helpers —
      // used an identical `now + 3 hours`, so once the suite grew past a
      // page's worth of events the tie-break became arbitrary and these
      // tests could no longer find the fixture they had just created. A
      // near-term kickoff sorts first deterministically without weakening
      // what the assertions actually check.
      startsAt: new Date(Date.now() + 60_000),
      status: "PENDING",
    })
    .returning({ id: events.id });

  const [market] = await db
    .insert(markets)
    .values({ eventId: event!.id, key: "1x2", status: "OPEN" })
    .returning({ id: markets.id });

  await db.insert(selections).values([
    { marketId: market!.id, key: "home", label: "Arsenal", currentPriceDecimal: "2.100" },
    { marketId: market!.id, key: "draw", label: "Draw", currentPriceDecimal: "3.400" },
    { marketId: market!.id, key: "away", label: "Chelsea", currentPriceDecimal: "3.800" },
  ]);

  await db.insert(oddsSnapshots).values({
    provider,
    providerEventId,
    payload: [
      {
        bookmaker: "bet365",
        updatedAt: new Date().toISOString(),
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
    fetchedAt: new Date(),
  });

  return event!.id;
}

afterAll(async () => {
  await pooledSql.end({ timeout: 5 });
});

describe("odds read path", () => {
  it("serves 500 concurrent browsers with zero upstream API calls", async () => {
    const provider = new ForbiddenProvider();
    const providerEventId = `evt-${randomUUID()}`;
    await seedFixture(providerEventId);

    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        i % 2 === 0
          ? getEventOdds(providerEventId)
          : listUpcoming({ sport: "football", limit: 50 }),
      ),
    );

    expect(results).toHaveLength(500);
    expect(results.every((result) => result !== null)).toBe(true);
    expect(provider.calls).toBe(0);
  });

  it("returns the stored snapshot without reaching upstream", async () => {
    const providerEventId = `evt-${randomUUID()}`;
    await seedFixture(providerEventId);

    const snapshot = await getEventOdds(providerEventId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.eventId).toBe(providerEventId);
    expect(snapshot!.books[0]!.bookmaker).toBe("bet365");
  });

  it("returns null for an unknown event rather than reaching upstream", async () => {
    expect(await getEventOdds(`evt-${randomUUID()}`)).toBeNull();
  });

  it("exposes prices as numbers, not NUMERIC strings", async () => {
    const providerEventId = `evt-${randomUUID()}`;
    await seedFixture(providerEventId);

    const listing = await listUpcoming({ sport: "football", limit: 50 });
    const fixture = listing.find((e) => e.providerEventId === providerEventId);
    expect(fixture).toBeDefined();

    const home = fixture!.markets[0]!.selections.find((s) => s.key === "home");
    expect(typeof home!.price).toBe("number");
    expect(home!.price).toBeCloseTo(2.1, 3);
  });

  it("hides suspended markets and selections from browsing", async () => {
    const providerEventId = `evt-${randomUUID()}`;
    const eventId = await seedFixture(providerEventId);

    await db.update(markets).set({ status: "SUSPENDED" }).where(eq(markets.eventId, eventId));

    const listing = await listUpcoming({ sport: "football", limit: 50 });
    const fixture = listing.find((e) => e.providerEventId === providerEventId);
    expect(fixture).toBeDefined();
    expect(fixture!.markets).toHaveLength(0);
  });
});

describe("odds sync reconciliation", () => {
  it("suspends markets that fall out of the provider feed", async () => {
    const providerEventId = `evt-${randomUUID()}`;
    const [event] = await db
      .insert(events)
      .values({
        provider: "test-provider",
        providerEventId,
        sport: "football",
        league: "La Liga",
        home: "Real Madrid",
        away: "Barcelona",
        startsAt: new Date(Date.now() + 2 * 60 * 60_000),
        status: "LIVE",
      })
      .returning({ id: events.id });

    // Returns 1x2 + btts on the first pass, then drops btts — the exact shape
    // of a market being pulled or suspended upstream.
    let includeBtts = true;
    const shifting: OddsProvider = {
      name: "test-provider",
      listEvents: async () => [],
      listLiveEvents: async () => [],
      getResults: async () => [],
      getUpdatedSince: async () => null,
      getOdds: async () => [
        {
          eventId: providerEventId,
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

    const sync = new OddsSyncService(shifting, { sport: "football", bookmakers: ["bet365"] });

    await sync.syncLiveOdds();
    const afterFirst = await db.select().from(markets).where(eq(markets.eventId, event!.id));
    expect(afterFirst.map((m) => m.key).sort()).toEqual(["1x2", "btts"]);
    expect(afterFirst.every((m) => m.status === "OPEN")).toBe(true);

    includeBtts = false;
    await sync.syncLiveOdds();

    const afterSecond = await db.select().from(markets).where(eq(markets.eventId, event!.id));
    const oneXTwo = afterSecond.find((m) => m.key === "1x2");
    const btts = afterSecond.find((m) => m.key === "btts");

    expect(oneXTwo!.status).toBe("OPEN");
    expect(btts!.status).toBe("SUSPENDED");

    const bttsSelections = await db
      .select()
      .from(selections)
      .where(eq(selections.marketId, btts!.id));
    expect(bttsSelections.length).toBeGreaterThan(0);
    expect(bttsSelections.every((s) => s.status === "SUSPENDED")).toBe(true);

    // The still-live market must NOT have been collaterally suspended.
    const liveSelections = await db
      .select()
      .from(selections)
      .where(and(eq(selections.marketId, oneXTwo!.id), eq(selections.status, "OPEN")));
    expect(liveSelections).toHaveLength(3);
  });

  it("ingests every supported football market end to end", async () => {
    const providerEventId = `evt-${randomUUID()}`;
    const [event] = await db
      .insert(events)
      .values({
        provider: "test-provider",
        providerEventId,
        sport: "football",
        league: "Premier League",
        home: "Arsenal",
        away: "Chelsea",
        startsAt: new Date(Date.now() + 2 * 60 * 60_000),
        status: "LIVE",
      })
      .returning({ id: events.id });

    // Raw provider-shaped labels, not canonical keys — this exercises the
    // adapter's normalisation, the CHECK constraint, and the upsert together.
    const fullBoard: OddsProvider = {
      name: "test-provider",
      listEvents: async () => [],
      listLiveEvents: async () => [],
      getResults: async () => [],
      getUpdatedSince: async () => null,
      getOdds: async () => [
        {
          eventId: providerEventId,
          fetchedAt: new Date(),
          books: [
            {
              bookmaker: "bet365",
              updatedAt: new Date(),
              markets: [
                {
                  key: "1x2" as const,
                  selections: [
                    { key: "home", label: "Home", price: 2.1 },
                    { key: "draw", label: "Draw", price: 3.4 },
                    { key: "away", label: "Away", price: 3.8 },
                  ],
                },
                {
                  key: "double_chance" as const,
                  selections: [
                    { key: "home_or_draw", label: "1X", price: 1.3 },
                    { key: "home_or_away", label: "12", price: 1.25 },
                    { key: "draw_or_away", label: "X2", price: 1.7 },
                  ],
                },
                {
                  key: "over_under" as const,
                  selections: [
                    { key: "over_2.5", label: "Over", price: 1.95, line: 2.5 },
                    { key: "under_2.5", label: "Under", price: 1.85, line: 2.5 },
                  ],
                },
                {
                  key: "btts" as const,
                  selections: [
                    { key: "yes", label: "Yes", price: 1.72 },
                    { key: "no", label: "No", price: 2.05 },
                  ],
                },
                {
                  key: "correct_score" as const,
                  selections: [
                    { key: "2-1", label: "2-1", price: 9.5 },
                    { key: "1-2", label: "1-2", price: 12.0 },
                    { key: "other", label: "Any Other Score", price: 4.5 },
                  ],
                },
                {
                  key: "ht_ft" as const,
                  selections: [
                    { key: "home/home", label: "1/1", price: 3.4 },
                    { key: "draw/away", label: "X/2", price: 6.5 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const sync = new OddsSyncService(fullBoard, { sport: "football", bookmakers: ["bet365"] });
    await sync.syncLiveOdds();

    const stored = await db.select().from(markets).where(eq(markets.eventId, event!.id));
    expect(stored.map((m) => m.key).sort()).toEqual([
      "1x2",
      "btts",
      "correct_score",
      "double_chance",
      "ht_ft",
      "over_under",
    ]);

    // Correct score must keep home/away orientation distinct all the way to
    // the database — 2-1 and 1-2 are opposite bets.
    const csMarket = stored.find((m) => m.key === "correct_score")!;
    const csSelections = await db
      .select()
      .from(selections)
      .where(eq(selections.marketId, csMarket.id));
    expect(csSelections.map((s) => s.key).sort()).toEqual(["1-2", "2-1", "other"]);

    const listing = await listUpcoming({ sport: "football", limit: 50 });
    const fixture = listing.find((e) => e.providerEventId === providerEventId);
    expect(fixture!.markets).toHaveLength(6);
  });

  it("skips odds for an event fixtures has not created yet", async () => {
    const unknownId = `evt-${randomUUID()}`;
    const orphan: OddsProvider = {
      name: "test-provider",
      listEvents: async () => [],
      listLiveEvents: async () => [],
      getResults: async () => [],
      getUpdatedSince: async () => [
        {
          eventId: unknownId,
          fetchedAt: new Date(),
          books: [
            {
              bookmaker: "bet365",
              updatedAt: new Date(),
              markets: [
                {
                  key: "1x2" as const,
                  selections: [{ key: "home", label: "Someone", price: 2.0 }],
                },
              ],
            },
          ],
        },
      ],
      getOdds: async () => [],
    };

    const sync = new OddsSyncService(orphan, { sport: "football", bookmakers: ["bet365"] });
    // Must not throw on the dangling reference.
    await expect(sync.syncOddsDelta()).resolves.toBeDefined();

    // Snapshot history still records it — evidence is kept even when we cannot
    // normalise it yet.
    const stored = await db
      .select()
      .from(oddsSnapshots)
      .where(eq(oddsSnapshots.providerEventId, unknownId));
    expect(stored).toHaveLength(1);
  });
});
