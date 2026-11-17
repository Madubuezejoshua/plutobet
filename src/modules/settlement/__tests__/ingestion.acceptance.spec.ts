import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { events } from "@/modules/odds/schema";
import type { EventResult, OddsProvider, OddsSnapshot, SportEvent } from "@/modules/odds/provider";
import {
  closeBettingContexts,
  createBettingContext,
  seedMarket,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { ResultIngestionService } from "../ingestion.service";
import { SettlementService } from "../settlement.service";

const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

/** Provider stub that returns whatever results the test hands it. */
function providerReturning(results: EventResult[], name = "test-provider"): OddsProvider & {
  requested: string[][];
} {
  const requested: string[][] = [];
  return {
    name,
    requested,
    listEvents: async (): Promise<SportEvent[]> => [],
    listLiveEvents: async (): Promise<SportEvent[]> => [],
    getOdds: async (): Promise<OddsSnapshot[]> => [],
    getUpdatedSince: async (): Promise<OddsSnapshot[] | null> => null,
    getResults: async (ids: string[]): Promise<EventResult[]> => {
      requested.push(ids);
      return results.filter((r) => ids.includes(r.eventId));
    },
  };
}

/** Pushes an event's kickoff into the past so the poller considers it due. */
async function backdateKickoff(ctx: BettingContext, eventId: string, hoursAgo: number) {
  await ctx.database.execute(sql`
    UPDATE events SET starts_at = now() - (${hoursAgo}::text || ' hours')::interval
    WHERE id = ${eventId}::uuid
  `);
}

async function providerEventIdOf(ctx: BettingContext, eventId: string): Promise<string> {
  const [row] = await ctx.database
    .select({ providerEventId: events.providerEventId })
    .from(events)
    .where(eq(events.id, eventId));
  return row!.providerEventId;
}

describe("result ingestion", () => {
  it("ingests a finished match and marks the event settled", async () => {
    const ctx = context();
    const market = await seedMarket(ctx);
    await backdateKickoff(ctx, market.eventId, 4);
    const providerEventId = await providerEventIdOf(ctx, market.eventId);

    const provider = providerReturning([
      {
        eventId: providerEventId,
        status: "SETTLED",
        home: 2,
        away: 1,
        periods: { p1: { home: 1, away: 0 }, ft: { home: 2, away: 1 } },
      },
    ]);

    const ingestion = new ResultIngestionService(
      provider,
      new SettlementService(ctx.wallet),
      ctx.wallet,
    );
    const finished = await ingestion.pollFinishedEvents();

    expect(finished).toEqual([{ eventId: market.eventId, cancelled: false }]);

    const stored = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM event_results WHERE event_id = ${market.eventId}::uuid
    `);
    expect(Number(stored[0]!.n)).toBe(1);

    const [row] = await ctx.database
      .select({ status: events.status })
      .from(events)
      .where(eq(events.id, market.eventId));
    expect(row!.status).toBe("SETTLED");
  }, 120_000);

  it("does not re-ingest an event that already has a result", async () => {
    const ctx = context();
    const market = await seedMarket(ctx);
    await backdateKickoff(ctx, market.eventId, 4);
    const providerEventId = await providerEventIdOf(ctx, market.eventId);

    const provider = providerReturning([
      {
        eventId: providerEventId,
        status: "SETTLED",
        home: 1,
        away: 0,
        periods: { ft: { home: 1, away: 0 } },
      },
    ]);
    const ingestion = new ResultIngestionService(
      provider,
      new SettlementService(ctx.wallet),
      ctx.wallet,
    );

    await ingestion.pollFinishedEvents();
    const second = await ingestion.pollFinishedEvents();

    // The second tick must not spend a provider call on it again.
    expect(second).toEqual([]);
    expect(provider.requested).toHaveLength(1);
  }, 120_000);

  it("ignores matches that have not reached their assumed finish time", async () => {
    const ctx = context();
    await seedMarket(ctx); // kicks off in 3 hours, so it is not yet assumed finished
    const provider = providerReturning([]);
    const ingestion = new ResultIngestionService(
      provider,
      new SettlementService(ctx.wallet),
      ctx.wallet,
    );

    expect(await ingestion.pollFinishedEvents()).toEqual([]);
    // No upstream call at all — budget is the scarce resource.
    expect(provider.requested).toHaveLength(0);
  }, 120_000);

  it("skips a finished match whose feed carries no regulation score", async () => {
    const ctx = context();
    const market = await seedMarket(ctx);
    await backdateKickoff(ctx, market.eventId, 4);
    const providerEventId = await providerEventIdOf(ctx, market.eventId);

    // Only extra time present — settlement reads `ft` and would have nothing
    // to compare against, so recording this would just fail every bet later.
    const provider = providerReturning([
      {
        eventId: providerEventId,
        status: "SETTLED",
        home: 2,
        away: 1,
        periods: { ot: { home: 2, away: 1 } },
      },
    ]);
    const ingestion = new ResultIngestionService(
      provider,
      new SettlementService(ctx.wallet),
      ctx.wallet,
    );

    expect(await ingestion.pollFinishedEvents()).toEqual([]);
    const stored = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM event_results WHERE event_id = ${market.eventId}::uuid
    `);
    expect(Number(stored[0]!.n)).toBe(0);
  }, 120_000);

  it("records a cancelled match even without scores", async () => {
    const ctx = context();
    const market = await seedMarket(ctx);
    await backdateKickoff(ctx, market.eventId, 4);
    const providerEventId = await providerEventIdOf(ctx, market.eventId);

    const provider = providerReturning([
      { eventId: providerEventId, status: "CANCELLED", home: 0, away: 0, periods: {} },
    ]);
    const ingestion = new ResultIngestionService(
      provider,
      new SettlementService(ctx.wallet),
      ctx.wallet,
    );

    expect(await ingestion.pollFinishedEvents()).toEqual([
      { eventId: market.eventId, cancelled: true },
    ]);
    const [row] = await ctx.database
      .select({ status: events.status })
      .from(events)
      .where(eq(events.id, market.eventId));
    expect(row!.status).toBe("CANCELLED");
  }, 120_000);

  it("drops non-integer scores rather than rounding them into a settlement", async () => {
    const ctx = context();
    const market = await seedMarket(ctx);
    await backdateKickoff(ctx, market.eventId, 4);
    const providerEventId = await providerEventIdOf(ctx, market.eventId);

    const provider = providerReturning([
      {
        eventId: providerEventId,
        status: "SETTLED",
        home: 2,
        away: 1,
        periods: {
          ft: { home: 2, away: 1 },
          // Junk from the feed. Must not reach the resolver.
          p1: { home: 1.5, away: Number.NaN } as unknown as { home: number; away: number },
        },
      },
    ]);
    const ingestion = new ResultIngestionService(
      provider,
      new SettlementService(ctx.wallet),
      ctx.wallet,
    );
    await ingestion.pollFinishedEvents();

    const rows = await ctx.database.execute<{ periods: Record<string, unknown> }>(sql`
      SELECT periods FROM event_results WHERE event_id = ${market.eventId}::uuid
    `);
    expect(rows[0]!.periods).toEqual({ ft: { home: 2, away: 1 } });
  }, 120_000);
});
