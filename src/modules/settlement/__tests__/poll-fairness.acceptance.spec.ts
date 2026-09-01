import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { ResultIngestionService } from "../ingestion.service";
import type { EventResult, OddsProvider, OddsSnapshot, SportEvent } from "@/modules/odds/provider";

/**
 * Fair scheduling for result polling.
 *
 * The old query took the 20 oldest unresolved events by kickoff. Fixtures the
 * provider never scores stay unresolved forever and were re-fetched every run,
 * so newer events queued behind them — a real customer bet was observed
 * sitting 59th of 60, and four cycles never reached it.
 *
 * Two properties are pinned here: money waiting sorts first, and an event the
 * provider cannot score backs off instead of consuming a slot every cycle.
 */

/**
 * ONE context for the whole file.
 *
 * A context per test opened a client per test and exhausted the embedded
 * cluster’s connections. Isolation comes from the per-test provider name
 * instead, which is cheaper and does not depend on connection headroom.
 */
const shared: BettingContext = createBettingContext();
const contexts: BettingContext[] = [shared];
function context(): BettingContext {
  return shared;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

/**
 * Each test gets its own provider name.
 *
 * Events are FK-referenced by markets, selections and bet legs with ON DELETE
 * RESTRICT, so a between-test DELETE cannot work. The poller already filters
 * by provider, which makes a fresh namespace per test both free and stronger
 * than cleanup: no test can see another one’s rows even in principle.
 */
function uniqueProvider(): string {
  return `fairness-${randomUUID().slice(0, 8)}`;
}

/** Records which provider event ids each poll asked about. */
function fakeProvider(results: Map<string, EventResult>, name: string) {
  const asked: string[][] = [];
  const provider: OddsProvider = {
    name,
    async listEvents() {
      return [] as SportEvent[];
    },
    async listLiveEvents() {
      return [] as SportEvent[];
    },
    async getOdds() {
      return [] as OddsSnapshot[];
    },
    async getUpdatedSince() {
      return [] as OddsSnapshot[];
    },
    async getResults(ids) {
      asked.push([...ids]);
      return ids.map((id) => results.get(id)).filter((r): r is EventResult => Boolean(r));
    },
  };
  return { provider, asked };
}

/** Creates an event that finished `hoursAgo` and belongs to our fake provider. */
async function finishedEvent(
  ctx: BettingContext,
  hoursAgo: number,
  providerName: string,
): Promise<{ id: string; providerId: string }> {
  const market = await seedMarket(ctx, { prices: { home: "2.000" } });
  const providerId = `fair-${randomUUID()}`;
  await ctx.database.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    await tx.execute(sql`
      UPDATE events
      SET starts_at = now() - (${hoursAgo}::text || ' hours')::interval,
          provider = ${providerName},
          provider_event_id = ${providerId}
      WHERE id = ${market.eventId}::uuid
    `);
  });
  return { id: market.eventId, providerId };
}

async function placeBetOn(ctx: BettingContext, eventId: string): Promise<void> {
  const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
  const [selection] = await ctx.database.execute<{ id: string; price: string }>(sql`
    SELECT s.id::text, s.current_price_decimal::text AS price
    FROM selections s JOIN markets m ON m.id = s.market_id
    WHERE m.event_id = ${eventId}::uuid LIMIT 1
  `);
  // Placement refuses a started event, so the bet goes on before backdating.
  await ctx.database.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    await tx.execute(sql`
      UPDATE events SET starts_at = now() + interval '3 hours' WHERE id = ${eventId}::uuid
    `);
  });
  await ctx.placement.placeBet({
    userId,
    walletId,
    ip: "102.89.0.1",
    stakeMinor: 100_000n,
    idempotencyKey: slipKey(),
    legs: [{ selectionId: selection!.id, odds: selection!.price }],
  });
}

function settledResult(providerId: string): EventResult {
  return {
    eventId: providerId,
    status: "SETTLED",
    home: 1,
    away: 0,
    periods: { ft: { home: 1, away: 0 } },
  };
}

/** Finished, but the provider has no regulation score for it. */
function unscoredResult(providerId: string): EventResult {
  return { eventId: providerId, status: "SETTLED", home: 0, away: 0, periods: {} };
}

describe("result polling fairness", () => {
  it("polls an event with a pending bet BEFORE an older one without", async () => {
    const providerName = uniqueProvider();
    const ctx = context();
    const older = await finishedEvent(ctx, 20, providerName);
    const newerWithBet = await finishedEvent(ctx, 4, providerName);
    await placeBetOn(ctx, newerWithBet.id);
    await ctx.database.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      await tx.execute(sql`
        UPDATE events SET starts_at = now() - interval '4 hours' WHERE id = ${newerWithBet.id}::uuid
      `);
    });

    const { provider, asked } = fakeProvider(new Map(), providerName);
    await new ResultIngestionService(provider, undefined, ctx.wallet).pollFinishedEvents();

    expect(asked).toHaveLength(1);
    const order = asked[0]!;
    // Money waiting is the only thing that makes a delay matter to anybody.
    expect(order.indexOf(newerWithBet.providerId)).toBeLessThan(
      order.indexOf(older.providerId),
    );
  });

  it("backs off an event the provider cannot score, instead of re-asking every cycle", async () => {
    const providerName = uniqueProvider();
    const ctx = context();
    const unscored = await finishedEvent(ctx, 10, providerName);

    const results = new Map([[unscored.providerId, unscoredResult(unscored.providerId)]]);
    const { provider, asked } = fakeProvider(results, providerName);
    const service = new ResultIngestionService(provider, undefined, ctx.wallet);

    await service.pollFinishedEvents();
    await service.pollFinishedEvents();

    // The second run must NOT ask again: the first deferred it.
    expect(asked[0]).toContain(unscored.providerId);
    expect(asked[1] ?? []).not.toContain(unscored.providerId);

    const [row] = await ctx.database.execute<{ attempts: number; next: Date | null }>(sql`
      SELECT result_poll_attempts AS attempts, result_next_poll_at AS next
      FROM events WHERE id = ${unscored.id}::uuid
    `);
    expect(Number(row!.attempts)).toBe(1);
    expect(row!.next).not.toBeNull();
  });

  it("never marks an unscored event resolved — it stays settleable later", async () => {
    const providerName = uniqueProvider();
    const ctx = context();
    const unscored = await finishedEvent(ctx, 10, providerName);

    const { provider } = fakeProvider(new Map([[unscored.providerId, unscoredResult(unscored.providerId)]]), providerName);
    await new ResultIngestionService(provider, undefined, ctx.wallet).pollFinishedEvents();

    // A provider briefly missing data must not become a permanently unsettled
    // bet. No result row, and the event is still PENDING.
    const [state] = await ctx.database.execute<{ status: string; has_result: boolean }>(sql`
      SELECT status::text,
             EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = e.id) AS has_result
      FROM events e WHERE e.id = ${unscored.id}::uuid
    `);
    expect(state!.status).toBe("PENDING");
    expect(state!.has_result).toBe(false);
  });

  it("one permanently unscored event cannot starve a later one", async () => {
    const providerName = uniqueProvider();
    const ctx = context();
    const blocker = await finishedEvent(ctx, 30, providerName);
    const behind = await finishedEvent(ctx, 5, providerName);

    const results = new Map([
      [blocker.providerId, unscoredResult(blocker.providerId)],
      [behind.providerId, settledResult(behind.providerId)],
    ]);
    const { provider } = fakeProvider(results, providerName);
    const service = new ResultIngestionService(provider, undefined, ctx.wallet);

    await service.pollFinishedEvents();
    const second = await service.pollFinishedEvents();

    // The blocker deferred itself; the later event resolved regardless.
    const [state] = await ctx.database.execute<{ has_result: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM event_results r WHERE r.event_id = ${behind.id}::uuid) AS has_result
    `);
    expect(state!.has_result).toBe(true);
    expect(second).toBeDefined();
  });

  it("excludes events that already have a result", async () => {
    const providerName = uniqueProvider();
    const ctx = context();
    const done = await finishedEvent(ctx, 8, providerName);

    const { provider, asked } = fakeProvider(new Map([[done.providerId, settledResult(done.providerId)]]), providerName);
    const service = new ResultIngestionService(provider, undefined, ctx.wallet);

    await service.pollFinishedEvents();
    await service.pollFinishedEvents();

    expect(asked[0]).toContain(done.providerId);
    // Re-polling a resolved event is wasted budget and risks a second write.
    expect(asked[1] ?? []).not.toContain(done.providerId);
  });

  it("respects the per-poll batch limit", async () => {
    const providerName = uniqueProvider();
    const ctx = context();
    for (let i = 0; i < 25; i += 1) await finishedEvent(ctx, 6 + i, providerName);

    const { provider, asked } = fakeProvider(new Map(), providerName);
    await new ResultIngestionService(provider, undefined, ctx.wallet).pollFinishedEvents();

    // Provider calls are the scarce resource; the cap is what keeps a large
    // backlog from draining the daily quota in one tick.
    expect(asked[0]!.length).toBeLessThanOrEqual(20);
  });

  it("surfaces a provider failure rather than reporting an empty poll", async () => {
    const providerName = uniqueProvider();
    const ctx = context();
    await finishedEvent(ctx, 7, providerName);

    const failing: OddsProvider = {
      ...fakeProvider(new Map(), providerName).provider,
      async getResults() {
        throw new Error("provider unreachable");
      },
    };

    // A swallowed failure reads exactly like "nothing finished", which is how
    // an outage becomes a queue of unsettled bets nobody investigates.
    await expect(
      new ResultIngestionService(failing, undefined, ctx.wallet).pollFinishedEvents(),
    ).rejects.toThrow(/provider unreachable/);
  });
});
