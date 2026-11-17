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
import { operationalAlerts } from "../business.service";

/**
 * The alarm for a SILENT settlement stall.
 *
 * If the odds provider changes its response shape, ingestion refuses to record
 * results — correctly, since settling without a regulation score would pay
 * against a number that is not there. But refusing is invisible: the poll keeps
 * running, throws nothing, and bets simply stay PENDING while customers wait.
 *
 * `provider-contract.acceptance.spec.ts` catches that shape change in CI. This
 * catches it in PRODUCTION, where the provider can change without anybody
 * deploying anything.
 */

const IP = "102.89.0.1";

const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

/**
 * Moves an event's kickoff into the past.
 *
 * The bet has to be placed BEFORE kickoff — placement rejects a started event,
 * as it should — so the only honest way to reach this state is the way
 * production reaches it: place, then let time pass.
 *
 * The provider is reassigned at the same time, and that is not incidental.
 * `seedMarket` stamps every event "test-provider", and the ingestion suite
 * reasonably assumes it owns the "test-provider" events that are past their
 * finish time with no result — which is precisely the state this file
 * manufactures. Leaving them under that name made two ingestion tests fail by
 * spending provider calls on fixtures belonging to this file.
 *
 * The alarm itself is deliberately provider-agnostic: in production it must
 * fire whoever the feed is. So renaming here isolates the suites without
 * weakening what is under test.
 */
const STALL_PROVIDER = "stall-alarm-fixture";

async function backdateKickoff(ctx: BettingContext, eventId: string, hoursAgo: number) {
  await ctx.database.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    await tx.execute(sql`
      UPDATE events
      SET starts_at = now() - (${hoursAgo}::text || ' hours')::interval,
          provider = ${STALL_PROVIDER}
      WHERE id = ${eventId}::uuid
    `);
  });
}

function settlementAlert(alerts: Awaited<ReturnType<typeof operationalAlerts>>) {
  return alerts.find((a) => a.subsystem === "Settlement");
}

describe("settlement stall alarm", () => {
  it("raises DOWN when a finished match with pending bets has no result", async () => {
    const ctx = context();
    const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      idempotencyKey: slipKey(),
      stakeMinor: 100_000n,
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    await backdateKickoff(ctx, market.eventId, 8);

    const alert = settlementAlert(await operationalAlerts());

    expect(alert, "no Settlement alert was raised for a stalled match").toBeDefined();
    expect(alert!.state).toBe("DOWN");
    // The operator needs to know where to look, not merely that something is wrong.
    expect(alert!.detail).toMatch(/provider response shape/i);
  });

  it("stays quiet while the match is still within its settling window", async () => {
    const ctx = context();
    const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      idempotencyKey: slipKey(),
      stakeMinor: 100_000n,
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    // Four hours: past the three-hour assumed finish, so the poll is trying,
    // but well inside the six-hour grace. An alert here would fire on every
    // ordinary evening fixture and teach operators to ignore the alarm.
    await backdateKickoff(ctx, market.eventId, 4);

    const alert = settlementAlert(await operationalAlerts());
    if (alert) {
      // Another test in this file may legitimately have left a stalled event
      // behind. Assert only that OURS is not the cause.
      expect(alert.detail).not.toContain(market.eventId);
    }
  });

  it("ignores a stalled match nobody has money on", async () => {
    const ctx = context();
    const market = await seedMarket(ctx);
    await backdateKickoff(ctx, market.eventId, 24);

    const before = settlementAlert(await operationalAlerts());
    const countBefore = before ? Number(before.detail.match(/^(\d+)/)?.[1] ?? 0) : 0;

    // A second unbetted stale event must not move the count. The alarm is
    // about customers waiting to be paid, and a fixture nobody backed is a
    // data-hygiene matter, not a page-somebody-at-3am matter.
    const second = await seedMarket(ctx);
    await backdateKickoff(ctx, second.eventId, 24);

    const after = settlementAlert(await operationalAlerts());
    const countAfter = after ? Number(after.detail.match(/^(\d+)/)?.[1] ?? 0) : 0;

    expect(countAfter).toBe(countBefore);
  });
});
