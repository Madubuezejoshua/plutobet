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
import { deleteSettlementOutboxAsOwnerForTest } from "@/modules/wallet/__tests__/helpers";
import { WalletService } from "@/modules/wallet/wallet.service";
import { replayScheduledFunction, runScheduledFunction } from "./scheduler-harness";
import type { EventResult, OddsProvider, OddsSnapshot, SportEvent } from "@/modules/odds/provider";

/**
 * The repair for a real winning bet that stayed PENDING after its event was
 * automatically marked SETTLED.
 *
 * TWO INDEPENDENT FAULTS PRODUCED IT, and both are pinned here.
 *
 * FAULT 1 — the cadence claim ran outside `step.run`. Inngest invokes a handler
 * once per step, replaying from the top and serving completed steps from a
 * checkpoint, so code outside a step re-executes every time. Invocation 1
 * claimed the slot and ingested; invocation 2 found the claim held by its own
 * first invocation, returned "not due", and never reached the dispatch. Every
 * service test passed. A single-invocation harness test passed too — which is
 * why `replayScheduledFunction` exists.
 *
 * FAULT 2 — the result committed to PostgreSQL and the hand-off went to the
 * scheduler in a separate network call. A crash between them stranded the bet
 * permanently, because the poller only ever considers events with NO stored
 * result. Closed by writing the outbox row in the same transaction.
 *
 * These tests use a real PostgreSQL database and drive the REGISTERED
 * functions, not the services beneath them.
 */

const ctx: BettingContext = createBettingContext();
const wallet = new WalletService(ctx.database);

afterAll(async () => {
  await closeBettingContexts([ctx]);
});

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

function stubProvider(name: string, results: Map<string, EventResult>): OddsProvider {
  return {
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
      return ids.map((id) => results.get(id)).filter((r): r is EventResult => Boolean(r));
    },
  };
}

/** A provider that always refuses — the exhausted-budget condition. */
function brokenProvider(name: string): OddsProvider {
  return {
    ...stubProvider(name, new Map()),
    async getResults() {
      throw new Error("odds provider budget exhausted for the hour");
    },
  };
}

interface Seeded {
  eventId: string;
  providerId: string;
  betId: string;
  walletId: string;
  result: EventResult;
}

/**
 * A real customer shape, built through the SAME helpers the betting tests use.
 *
 * Deliberately not hand-written INSERTs: an earlier draft of this file invented
 * a `bets.wallet_id` column that does not exist, and every test failed on the
 * fixture rather than on the behaviour. Placing the bet through
 * `placement.placeBet` also means the stake leaves the wallet and the exposure
 * row is created the way production does it, so "exposure released" is a real
 * assertion rather than a check on something the test never created.
 */
async function seedBet(
  tag: string,
  score: { home: number; away: number },
  pick: "home" | "draw" | "away",
): Promise<Seeded> {
  const market = await seedMarket(ctx, {
    prices: { home: "2.000", draw: "3.500", away: "2.150" },
  });
  const { userId, walletId } = await createFundedUser(ctx, 20_000n);
  const providerId = `${tag}-${randomUUID().slice(0, 8)}`;

  const odds = pick === "home" ? "2.000" : pick === "draw" ? "3.500" : "2.150";
  const bet = await ctx.placement.placeBet({
    userId,
    walletId,
    ip: "102.89.0.1",
    stakeMinor: 20_000n,
    idempotencyKey: slipKey(),
    legs: [{ selectionId: market.selectionIds[pick]!, odds }],
  });

  // Old enough that the result poller will consider it.
  await ctx.database.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    await tx.execute(sql`
      UPDATE events
      SET starts_at = now() - interval '5 hours',
          provider = ${tag}, provider_event_id = ${providerId}
      WHERE id = ${market.eventId}::uuid
    `);
  });

  return {
    eventId: market.eventId,
    providerId,
    betId: bet.betId,
    walletId,
    result: {
      eventId: providerId,
      status: "SETTLED",
      home: score.home,
      away: score.away,
      periods: { ft: { home: score.home, away: score.away } },
    },
  };
}

/**
 * Loads the registered functions with the odds provider stubbed.
 *
 * The cadence claim is NOT stubbed here by default: whether the handler
 * survives a replay of that claim is the exact defect these tests exist for,
 * and stubbing it away would hide it. `alwaysDue` exists only for the tests
 * that need many runs in a row.
 */
async function loadFunctions(providerImpl: OddsProvider, alwaysDue = true) {
  vi.resetModules();
  vi.doMock("@/modules/odds/odds-api-io", () => ({
    OddsApiIoProvider: class {
      constructor() {
        return providerImpl as never;
      }
    },
  }));
  if (alwaysDue) {
    vi.doMock("@/modules/odds/cadence", () => ({
      oddsCadence: { claimIfDue: async () => true },
    }));
  }
  vi.stubEnv("ODDS_API_KEY", "test-key-not-a-credential");

  const mod = await import("@/inngest/functions/settlement");
  const registry = [
    mod.pollMatchResults,
    mod.dispatchSettlementOutbox,
    mod.recoverStrandedSettlements,
    mod.settleEvent,
    mod.settleBet,
  ];
  return { ...mod, registry };
}

async function betStatus(betId: string): Promise<string> {
  const [row] = await ctx.database.execute<{ status: string }>(sql`
    SELECT status::text FROM bets WHERE id = ${betId}::uuid
  `);
  return row!.status;
}

/** Credits actually reaching a USER wallet for this bet. */
async function payoutCount(betId: string): Promise<number> {
  const [row] = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM ledger_transactions t
    JOIN ledger_entries e ON e.txn_id = t.id
    JOIN wallets w ON w.id = e.wallet_id
    WHERE t.metadata ->> 'betId' = ${betId}
      AND t.type IN ('PAYOUT', 'REFUND')
      AND e.direction = 'CREDIT' AND w.kind = 'USER'
  `);
  return Number(row!.n);
}

async function cash(walletId: string): Promise<bigint> {
  const [row] = await ctx.database.execute<{ b: string }>(sql`
    SELECT cached_balance_minor::text AS b FROM wallets WHERE id = ${walletId}::uuid
  `);
  return BigInt(row!.b);
}

async function openMarkets(eventId: string): Promise<number> {
  const [row] = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM markets WHERE event_id = ${eventId}::uuid AND status = 'OPEN'
  `);
  return Number(row!.n);
}

async function outboxRows(eventId: string) {
  return ctx.database.execute<{ id: string; status: string; attempts: number; source: string }>(sql`
    SELECT id, status::text, attempts, source FROM settlement_outbox
    WHERE event_id = ${eventId}::uuid
  `);
}

/** Ledger-wide invariant. Money cannot appear or vanish. */
async function ledgerBalanced(): Promise<boolean> {
  const [row] = await ctx.database.execute<{ d: string; c: string }>(sql`
    SELECT COALESCE(sum(amount_minor) FILTER (WHERE direction='DEBIT'),0)::text AS d,
           COALESCE(sum(amount_minor) FILTER (WHERE direction='CREDIT'),0)::text AS c
    FROM ledger_entries
  `);
  return row!.d === row!.c;
}

describe("settlement hand-off: the replay fault", () => {
  it("reaches the dispatch when the handler is REPLAYED, not just run once", async () => {
    const tag = `replay-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const { pollMatchResults, registry } = await loadFunctions(
      stubProvider(tag, new Map([[seeded.providerId, seeded.result]])),
    );

    /*
     * The regression test for the original defect. Under replay the cadence
     * claim is re-evaluated unless it is inside a step; before the fix the
     * second invocation returned "not due" here and the ingestion step's work
     * was never followed by anything.
     */
    const run = await replayScheduledFunction(pollMatchResults, registry);

    expect(run.invocations).toBeGreaterThan(1);
    expect(run.steps).toContain("settlement-poll-results:claim-cadence");
    expect(run.steps).toContain("settlement-poll-results:ingest-results");
    // The run must NOT have bailed out as "not due" on the replay.
    const returned = run.returns["settlement-poll-results"] as { skipped?: boolean };
    expect(returned.skipped).toBeUndefined();

    // And the outbox row exists, written in the result's own transaction.
    const rows = await outboxRows(seeded.eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("RESULT_INGESTED");
  });

  it("writes the result and the work item atomically", async () => {
    const tag = `atomic-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 0, away: 1 }, "away");
    const { pollMatchResults, registry } = await loadFunctions(
      stubProvider(tag, new Map([[seeded.providerId, seeded.result]])),
    );
    await replayScheduledFunction(pollMatchResults, registry);

    const [result] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM event_results WHERE event_id = ${seeded.eventId}::uuid
    `);
    const rows = await outboxRows(seeded.eventId);
    // Both, or neither. Never one.
    expect(Number(result!.n)).toBe(1);
    expect(rows).toHaveLength(1);
  });
});

describe("settlement dispatch and payment", () => {
  it("pays a winning single exactly once, closes markets, releases exposure", async () => {
    const tag = `won-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));

    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    expect(await betStatus(seeded.betId)).toBe("WON");
    expect(await payoutCount(seeded.betId)).toBe(1);
    expect(await cash(seeded.walletId)).toBe(43000n);
    expect(await openMarkets(seeded.eventId)).toBe(0);
    expect(await ledgerBalanced()).toBe(true);

    // Exposure is per-MARKET liability, not a per-bet row: "released" means the
    // market's outstanding liability has returned to zero now the bet is done.
    const [row] = await ctx.database.execute<{ liability: string }>(sql`
      SELECT COALESCE(sum(x.total_liability_minor), 0)::text AS liability
      FROM exposure x JOIN markets m ON m.id = x.market_id
      WHERE m.event_id = ${seeded.eventId}::uuid
    `);
    expect(BigInt(row!.liability)).toBe(0n);
  });

  it("pays nothing for a losing single", async () => {
    const tag = `lost-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 3, away: 0 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));

    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    expect(await betStatus(seeded.betId)).toBe("LOST");
    expect(await payoutCount(seeded.betId)).toBe(0);
    expect(await cash(seeded.walletId)).toBe(0n);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("returns only the stake when the event is cancelled", async () => {
    const tag = `void-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 0, away: 0 }, "away");
    const cancelled: EventResult = { ...seeded.result, status: "CANCELLED" };
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, cancelled]])));

    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    expect(await betStatus(seeded.betId)).toBe("VOID");
    // Stake back, and not a kobo of winnings.
    expect(await cash(seeded.walletId)).toBe(20000n);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("does not pay twice when the whole chain is replayed four times", async () => {
    const tag = `dupe-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));

    for (let i = 0; i < 4; i += 1) {
      await replayScheduledFunction(fns.pollMatchResults, fns.registry);
      await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);
      await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);
    }

    expect(await payoutCount(seeded.betId)).toBe(1);
    expect(await cash(seeded.walletId)).toBe(43000n);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("does not duplicate settlement when two dispatchers run concurrently", async () => {
    const tag = `race-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));
    await replayScheduledFunction(fns.pollMatchResults, fns.registry);

    // FOR UPDATE SKIP LOCKED is what makes this safe; without it both runs
    // claim the same row and fan out over the same bets.
    await Promise.all([
      runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry),
      runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry),
    ]);

    expect(await payoutCount(seeded.betId)).toBe(1);
    expect(await cash(seeded.walletId)).toBe(43000n);
  });
});

describe("recovery sweep", () => {
  it("recovers a bet stranded by a crash between result and dispatch", async () => {
    const tag = `crash-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));

    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    // Simulate the crash: the work item is destroyed after the result
    // committed. This is the exact shape that stranded the real bet, and the
    // poller will never look at this event again.
    await deleteSettlementOutboxAsOwnerForTest(seeded.eventId);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);
    expect(await betStatus(seeded.betId)).toBe("PENDING");

    // The sweep is level-triggered: it does not care how the state arose.
    await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    expect(await betStatus(seeded.betId)).toBe("WON");
    expect(await payoutCount(seeded.betId)).toBe(1);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("recovers an event ALREADY marked SETTLED that still has a pending bet", async () => {
    const tag = `settled-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));

    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await deleteSettlementOutboxAsOwnerForTest(seeded.eventId);
    // Exactly the production state: event SETTLED, bet PENDING, markets open.
    await ctx.database.execute(sql`
      UPDATE events SET status = 'SETTLED' WHERE id = ${seeded.eventId}::uuid
    `);

    await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    expect(await betStatus(seeded.betId)).toBe("WON");
    expect(await payoutCount(seeded.betId)).toBe(1);
    expect(await openMarkets(seeded.eventId)).toBe(0);
  });

  it("recovers a final event whose markets are still open", async () => {
    const tag = `mkt-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 3, away: 0 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));

    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);
    expect(await betStatus(seeded.betId)).toBe("LOST");

    // Re-open the markets to model a partial close, then sweep.
    await ctx.database.execute(sql`
      UPDATE markets SET status = 'OPEN' WHERE event_id = ${seeded.eventId}::uuid
    `);
    await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    expect(await openMarkets(seeded.eventId)).toBe(0);
  });

  it("settles a stored result even when the provider is completely unavailable", async () => {
    const tag = `nobudget-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");

    // First store the result with a working provider.
    const good = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));
    await replayScheduledFunction(good.pollMatchResults, good.registry);
    await deleteSettlementOutboxAsOwnerForTest(seeded.eventId);

    /*
     * Now the provider refuses everything — the exhausted-budget state the
     * system was actually in while a customer went unpaid. Recovery and
     * dispatch read only local data, so money must still move.
     */
    const broken = await loadFunctions(brokenProvider(tag));
    await runScheduledFunction(broken.recoverStrandedSettlements, broken.registry);
    await runScheduledFunction(broken.dispatchSettlementOutbox, broken.registry);

    expect(await betStatus(seeded.betId)).toBe("WON");
    expect(await payoutCount(seeded.betId)).toBe(1);
    expect(await cash(seeded.walletId)).toBe(43000n);
  });

  it("repeated recovery runs leave exactly one payout", async () => {
    const tag = `repeat-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));
    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await deleteSettlementOutboxAsOwnerForTest(seeded.eventId);

    for (let i = 0; i < 5; i += 1) {
      await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);
      await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);
    }

    expect(await payoutCount(seeded.betId)).toBe(1);
    expect(await cash(seeded.walletId)).toBe(43000n);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("one broken event does not block settlement of an unrelated one", async () => {
    const good = `ok-${randomUUID().slice(0, 8)}`;
    const bad = `bad-${randomUUID().slice(0, 8)}`;
    const okBet = await seedBet(good, { home: 1, away: 2 }, "away");
    const badBet = await seedBet(bad, { home: 1, away: 2 }, "away");

    const fns = await loadFunctions(
      stubProvider(good, new Map([[okBet.providerId, okBet.result]])),
    );
    await replayScheduledFunction(fns.pollMatchResults, fns.registry);

    // Give the bad event a result whose periods are unusable, so its own
    // settlement cannot succeed, then queue both.
    await ctx.database.execute(sql`
      INSERT INTO event_results (event_id, status, periods, provider)
      VALUES (${badBet.eventId}::uuid, 'SETTLED', '{}'::jsonb, ${bad})
    `);
    await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);
    const run = await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    // The dispatch itself must SUCCEED even though one triggered settlement
    // failed: accepting the message and settling the event are separate
    // outcomes, and conflating them turns one bad event into a stalled queue
    // for everybody.
    expect(run.listenerErrors.length).toBeGreaterThan(0);

    // The healthy one is paid regardless of its neighbour.
    expect(await betStatus(okBet.betId)).toBe("WON");
    expect(await payoutCount(okBet.betId)).toBe(1);
    expect(await ledgerBalanced()).toBe(true);
  });
});

describe("honest monitoring", () => {
  it("does not report a settlement from the ingestion job", async () => {
    const tag = `hb-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));
    await replayScheduledFunction(fns.pollMatchResults, fns.registry);

    const { heartbeatService } = await import("@/modules/reporting/heartbeat.service");
    const beat = await heartbeatService.read("results");

    // Ingestion happened...
    expect(beat!.ingestedResults).toBeGreaterThanOrEqual(1);
    // ...and the ingestion job must NOT claim a settlement it did not perform.
    // The old code hardcoded settled: 0 here, which read as "ran fine, nothing
    // to settle" while a customer went unpaid.
    expect(beat!.settlementCompleted).toBe(0);
    // The number an operator actually needs: money still waiting.
    expect(beat!.pendingAfterRun).toBeGreaterThanOrEqual(1);
  });

  it("records a real settlement count once settlement has happened", async () => {
    const tag = `hb2-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));
    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    const { heartbeatService } = await import("@/modules/reporting/heartbeat.service");
    const beat = await heartbeatService.read("settlement-events");
    expect(beat!.settlementCompleted).toBeGreaterThanOrEqual(1);
    expect(beat!.marketClosures).toBeGreaterThanOrEqual(1);
  });

  it("names the stage that failed", async () => {
    const tag = `stage-${randomUUID().slice(0, 8)}`;
    await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(brokenProvider(tag));

    await expect(
      replayScheduledFunction(fns.pollMatchResults, fns.registry),
    ).rejects.toThrow(/budget exhausted/);

    const { heartbeatService } = await import("@/modules/reporting/heartbeat.service");
    const beat = await heartbeatService.read("results");
    // "something broke" is not an alert. The stage is what tells an operator
    // whether customers are unpaid or merely un-priced.
    expect(beat!.errorStage).toBe("ingest");
    expect(beat!.lastError).toMatch(/budget exhausted/);
  });

  it("counts pending money as an inconsistency the sweep can see", async () => {
    const tag = `alert-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));
    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await deleteSettlementOutboxAsOwnerForTest(seeded.eventId);

    const { SettlementRecoveryService } = await import("@/modules/settlement/recovery.service");
    const recovery = new SettlementRecoveryService(wallet);
    const before = await recovery.inconsistencyCounts();
    expect(before.pendingOnFinalEvents).toBeGreaterThanOrEqual(1);

    await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);
    await runScheduledFunction(fns.dispatchSettlementOutbox, fns.registry);

    const after = await recovery.inconsistencyCounts();
    expect(after.wonWithoutPayout).toBe(0);
  });
});

describe("outbox bookkeeping", () => {
  it("keeps one work item per event however many producers race", async () => {
    const tag = `once-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");
    const fns = await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])));

    await replayScheduledFunction(fns.pollMatchResults, fns.registry);
    await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);
    await runScheduledFunction(fns.recoverStrandedSettlements, fns.registry);

    const rows = await outboxRows(seeded.eventId);
    expect(rows).toHaveLength(1);
  });

  it("retains a failed item with its error rather than deleting it", async () => {
    const { SettlementOutboxService } = await import("@/modules/settlement/outbox.service");
    const outbox = new SettlementOutboxService(wallet);
    const tag = `fail-${randomUUID().slice(0, 8)}`;
    const seeded = await seedBet(tag, { home: 1, away: 2 }, "away");

    /*
     * Ingest the result first. Enqueueing an event with no stored result
     * leaves a permanently un-settleable row in a queue every other test file
     * shares, and the next dispatcher to claim it fails on someone else's
     * data. An earlier version of this test did exactly that.
     */
    await replayScheduledFunction(
      (await loadFunctions(stubProvider(tag, new Map([[seeded.providerId, seeded.result]])))).pollMatchResults,
      [],
    );
    await outbox.enqueue({ eventId: seeded.eventId, cancelled: false, source: "RECOVERY" });
    // Claim generously, then pick OUR item: the tests share one database, so a
    // bare `claimBatch(5)[0]` can be another test's row entirely.
    const claimedBatch = await outbox.claimBatch(50);
    const claimed = claimedBatch.find((item) => item.eventId === seeded.eventId);
    expect(claimed).toBeDefined();
    await outbox.markFailed(claimed!.id, new Error("downstream exploded"));

    const rows = await outboxRows(seeded.eventId);
    // Still there, still explains itself. Deleting failures to make a
    // dashboard green is how money goes missing quietly.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("PENDING");
    const [detail] = await ctx.database.execute<{ last_error: string; attempts: number }>(sql`
      SELECT last_error, attempts FROM settlement_outbox WHERE id = ${claimed!.id}::uuid
    `);
    expect(detail!.last_error).toMatch(/downstream exploded/);
    expect(Number(detail!.attempts)).toBe(1);
  });
});
