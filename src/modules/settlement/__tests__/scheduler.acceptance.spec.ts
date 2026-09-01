import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import type { EventResult, OddsProvider, OddsSnapshot, SportEvent } from "@/modules/odds/provider";
import { cronOf, runScheduledFunction } from "./scheduler-harness";

/**
 * The REGISTERED scheduled function, end to end.
 *
 * Everything about settlement was previously proven by calling its services
 * directly. That proves the logic and says nothing about the entry point —
 * which mattered, because `pollMatchResults` had never executed once in the
 * life of the project. Inngest was not running locally and the deployment had
 * no database, so the cron never fired and no bet ever settled on its own.
 *
 * These tests drive `pollMatchResults.fn` — the real handler — and follow the
 * events it emits into `settleEvent` and `settleBet`, which is the chain the
 * platform would run. The harness models step semantics, not durability; see
 * its header for what that deliberately excludes.
 */

const ctx: BettingContext = createBettingContext();

afterAll(async () => {
  await closeBettingContexts([ctx]);
});

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

/** A provider serving canned results, recording what was asked for. */
function provider(name: string, results: Map<string, EventResult>, failWith?: Error) {
  const asked: string[][] = [];
  const impl: OddsProvider = {
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
      if (failWith) throw failWith;
      return ids.map((id) => results.get(id)).filter((r): r is EventResult => Boolean(r));
    },
  };
  return { impl, asked };
}

/**
 * Loads the settlement module with the odds provider and cadence stubbed.
 *
 * The provider is replaced because a test must not call odds-api.io. The
 * cadence claim is replaced because it is a Redis SET NX with a five-minute
 * TTL — real and correct in production, but it would make the second
 * invocation in a replay test silently skip, hiding the very idempotency the
 * test exists to prove. Overlap protection gets its own test below, where the
 * real claim semantics are asserted directly.
 */
async function loadFunctions(providerImpl: OddsProvider, alwaysDue = true) {
  vi.doMock("@/modules/odds/odds-api-io", () => ({
    OddsApiIoProvider: class {
      constructor() {
        return providerImpl as never;
      }
    },
  }));
  vi.doMock("@/modules/odds/cadence", () => ({
    oddsCadence: { claimIfDue: async () => alwaysDue },
  }));
  vi.stubEnv("ODDS_API_KEY", "test-key");

  const mod = await import("@/inngest/functions/settlement");
  return {
    pollMatchResults: mod.pollMatchResults,
    registry: [mod.pollMatchResults, mod.settleEvent, mod.settleBet],
  };
}

async function finishedEventWithBet(
  providerName: string,
  outcome: { home: number; away: number },
  selectionKey: "home" | "away" | "draw" = "home",
) {
  const market = await seedMarket(ctx, { prices: { home: "2.000", draw: "3.500", away: "4.000" } });
  const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
  const providerId = `sched-${randomUUID()}`;

  const bet = await ctx.placement.placeBet({
    userId,
    walletId,
    ip: "102.89.0.1",
    stakeMinor: 100_000n,
    idempotencyKey: slipKey(),
    legs: [{ selectionId: market.selectionIds[selectionKey]!, odds: selectionKey === "home" ? "2.000" : selectionKey === "draw" ? "3.500" : "4.000" }],
  });

  await ctx.database.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    await tx.execute(sql`
      UPDATE events
      SET starts_at = now() - interval '5 hours',
          provider = ${providerName}, provider_event_id = ${providerId}
      WHERE id = ${market.eventId}::uuid
    `);
  });

  const result: EventResult = {
    eventId: providerId,
    status: "SETTLED",
    home: outcome.home,
    away: outcome.away,
    periods: { ft: { home: outcome.home, away: outcome.away } },
  };

  return { market, userId, walletId, betId: bet.betId, providerId, result };
}

async function cashBalance(walletId: string): Promise<bigint> {
  const [row] = await ctx.database.execute<{ bal: string }>(sql`
    SELECT cached_balance_minor::text AS bal FROM wallets WHERE id = ${walletId}::uuid
  `);
  return BigInt(row!.bal);
}

async function payoutLegs(betId: string): Promise<number> {
  const [row] = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM ledger_transactions t
    JOIN ledger_entries e ON e.txn_id = t.id
    JOIN wallets w ON w.id = e.wallet_id
    WHERE t.metadata ->> 'betId' = ${betId}
      AND t.type IN ('PAYOUT', 'REFUND')
      AND e.direction = 'CREDIT' AND w.kind = 'USER'
  `);
  return Number(row?.n ?? 0);
}

async function betStatus(betId: string): Promise<string> {
  const [row] = await ctx.database.execute<{ status: string }>(sql`
    SELECT status::text FROM bets WHERE id = ${betId}::uuid
  `);
  return row!.status;
}

describe("the registered settlement scheduler", () => {
  it("is registered on a cron trigger", async () => {
    const { impl } = provider("reg", new Map());
    const { pollMatchResults } = await loadFunctions(impl);
    // If this is not a cron, nothing ever invokes it — which is precisely the
    // state the project was in, with the function correct and never called.
    expect(cronOf(pollMatchResults)).toBe("* * * * *");
  });

  it("settles a WINNING bet through the whole chain, paying exactly once", async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`;
    const seeded = await finishedEventWithBet(name, { home: 2, away: 0 }, "home");
    const before = await cashBalance(seeded.walletId);

    const { impl } = provider(name, new Map([[seeded.providerId, seeded.result]]));
    const { pollMatchResults, registry } = await loadFunctions(impl);

    const run = await runScheduledFunction(pollMatchResults, registry);

    // The chain, proven by the steps that actually executed.
    expect(run.steps.some((s) => s.includes("ingest-results"))).toBe(true);
    expect(run.steps.some((s) => s.includes("find-pending-bets"))).toBe(true);
    expect(run.steps.some((s) => s.includes("close-markets"))).toBe(true);
    expect(run.events.some((e) => e.name === "settlement/event.finished")).toBe(true);
    expect(run.events.some((e) => e.name === "settlement/bet.requested")).toBe(true);

    expect(await betStatus(seeded.betId)).toBe("WON");
    expect(await payoutLegs(seeded.betId)).toBe(1);
    // 100,000 staked at 2.000 returns 200,000.
    expect(await cashBalance(seeded.walletId)).toBe(before + 200_000n);
  });

  it("settles a LOSING bet with no payout", async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`;
    const seeded = await finishedEventWithBet(name, { home: 0, away: 2 }, "home");
    const before = await cashBalance(seeded.walletId);

    const { impl } = provider(name, new Map([[seeded.providerId, seeded.result]]));
    const { pollMatchResults, registry } = await loadFunctions(impl);
    await runScheduledFunction(pollMatchResults, registry);

    expect(await betStatus(seeded.betId)).toBe("LOST");
    expect(await payoutLegs(seeded.betId)).toBe(0);
    // The stake left at placement; losing changes nothing further.
    expect(await cashBalance(seeded.walletId)).toBe(before);
  });

  it("returns only the stake on a VOID (cancelled) event", async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`;
    const seeded = await finishedEventWithBet(name, { home: 0, away: 0 }, "home");
    const before = await cashBalance(seeded.walletId);

    const cancelled: EventResult = { ...seeded.result, status: "CANCELLED", periods: {} };
    const { impl } = provider(name, new Map([[seeded.providerId, cancelled]]));
    const { pollMatchResults, registry } = await loadFunctions(impl);
    await runScheduledFunction(pollMatchResults, registry);

    expect(await betStatus(seeded.betId)).toBe("VOID");
    // Stake back, exactly — not the 200,000 it would have won.
    expect(await cashBalance(seeded.walletId)).toBe(before + 100_000n);
    expect(await payoutLegs(seeded.betId)).toBe(1);
  });

  it("REPLAYING the scheduled function pays a winner exactly once", async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`;
    const seeded = await finishedEventWithBet(name, { home: 2, away: 0 }, "home");
    const before = await cashBalance(seeded.walletId);

    const { impl } = provider(name, new Map([[seeded.providerId, seeded.result]]));
    const { pollMatchResults, registry } = await loadFunctions(impl);

    // Inngest retries. A scheduler that pays twice on a retry is worse than
    // one that never runs, because the loss is silent and cumulative.
    for (let i = 0; i < 4; i += 1) {
      await runScheduledFunction(pollMatchResults, registry);
    }

    expect(await betStatus(seeded.betId)).toBe("WON");
    expect(await payoutLegs(seeded.betId)).toBe(1);
    expect(await cashBalance(seeded.walletId)).toBe(before + 200_000n);
  });

  it("records a FAILURE heartbeat without marking the run successful", async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`;
    await finishedEventWithBet(name, { home: 1, away: 0 }, "home");

    const { impl } = provider(name, new Map(), new Error("provider unreachable"));
    const { pollMatchResults, registry } = await loadFunctions(impl);

    const { heartbeatService } = await import("@/modules/reporting/heartbeat.service");
    const beforeBeat = await heartbeatService.read("results");

    await expect(runScheduledFunction(pollMatchResults, registry)).rejects.toThrow(
      /provider unreachable/,
    );

    const afterBeat = await heartbeatService.read("results");
    expect(afterBeat?.lastFailureAt).not.toBeNull();
    expect(afterBeat?.lastError).toMatch(/provider unreachable/);
    // A failure must not advance the success clock, or the staleness alert
    // would stay quiet through a total outage.
    expect(afterBeat?.lastSuccessAt ?? null).toEqual(beforeBeat?.lastSuccessAt ?? null);
  });

  it("records a SUCCESS heartbeat with the processed count", async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`;
    const seeded = await finishedEventWithBet(name, { home: 1, away: 0 }, "home");

    const { impl } = provider(name, new Map([[seeded.providerId, seeded.result]]));
    const { pollMatchResults, registry } = await loadFunctions(impl);
    await runScheduledFunction(pollMatchResults, registry);

    const { heartbeatService } = await import("@/modules/reporting/heartbeat.service");
    const beat = await heartbeatService.read("results");
    expect(beat?.lastSuccessAt).not.toBeNull();
    expect(beat!.processedCount).toBeGreaterThanOrEqual(1);
  });

  it("does not run at all when the cadence slot is already claimed", async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`;
    const seeded = await finishedEventWithBet(name, { home: 2, away: 0 }, "home");
    const before = await cashBalance(seeded.walletId);

    // The real overlap guard: a SET NX claim that a concurrent invocation
    // loses. The loser must do nothing at all, not merely less.
    const { impl, asked } = provider(name, new Map([[seeded.providerId, seeded.result]]));
    const { pollMatchResults, registry } = await loadFunctions(impl, false);

    const run = await runScheduledFunction(pollMatchResults, registry);

    expect(asked).toHaveLength(0);
    expect(run.events).toHaveLength(0);
    expect(await betStatus(seeded.betId)).toBe("PENDING");
    expect(await cashBalance(seeded.walletId)).toBe(before);
  });

  it("prioritises an event carrying a pending bet over an older one without", async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`;
    // Older, no bet.
    const bare = await seedMarket(ctx, { prices: { home: "2.000" } });
    const bareProviderId = `sched-bare-${randomUUID()}`;
    await ctx.database.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      await tx.execute(sql`
        UPDATE events SET starts_at = now() - interval '30 hours',
                          provider = ${name}, provider_event_id = ${bareProviderId}
        WHERE id = ${bare.eventId}::uuid
      `);
    });
    const withBet = await finishedEventWithBet(name, { home: 1, away: 0 }, "home");

    const { impl, asked } = provider(name, new Map());
    const { pollMatchResults, registry } = await loadFunctions(impl);
    await runScheduledFunction(pollMatchResults, registry);

    const order = asked[0]!;
    expect(order.indexOf(withBet.providerId)).toBeLessThan(order.indexOf(bareProviderId));
  });
});
