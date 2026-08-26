import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { selections } from "@/modules/odds/schema";
import { SelectionUnavailableError } from "../errors";
import { bets, exposure } from "../schema";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "./helpers";

/**
 * PHASE 3 ACCEPTANCE CRITERION
 * ---------------------------
 * "A market suspended mid-request rolls back cleanly — no stake debited, no
 * exposure change."
 *
 * The other placement tests suspend the market BEFORE calling placeBet, which
 * only proves the status check reads a column. This file proves the race the
 * FOR SHARE locking actually exists for: a suspension that COMMITS while a
 * placement transaction is already in flight.
 *
 * It is made deterministic rather than timing-dependent by holding the
 * suspending transaction open: placement genuinely blocks on the row lock (we
 * assert that via pg_stat_activity), and only then does the suspension commit.
 */

const IP = "102.89.0.1";
const POLL_INTERVAL_MS = 25;
const BLOCK_TIMEOUT_MS = 10_000;

/**
 * Waits until some backend is genuinely blocked on a lock.
 *
 * Asserting this — rather than sleeping and hoping — is what makes the test
 * meaningful: if placement did NOT take the share lock, nothing would ever
 * block and this would time out, failing loudly instead of silently passing
 * for the wrong reason.
 */
async function waitForLockWaiter(observer: BettingContext): Promise<void> {
  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await observer.database.execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `);
    if (Number(rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    "placement never blocked on a row lock — the FOR SHARE guard is not doing its job",
  );
}

describe("market suspended mid-request", () => {
  const contexts: BettingContext[] = [];
  const context = () => {
    const created = createBettingContext();
    contexts.push(created);
    return created;
  };

  afterAll(async () => {
    await closeBettingContexts(contexts);
  });

  it("rolls back cleanly when the suspension commits during placement", async () => {
    const setup = context();
    const bettor = context();
    const suspender = context();
    const observer = context();

    const { userId, walletId } = await createFundedUser(setup, 1_000_000n);
    const market = await seedMarket(setup, { prices: { home: "2.000" } });

    // The suspending transaction takes an exclusive lock on the selection
    // rows and then HOLDS it, uncommitted, until we say so.
    let commitSuspension!: () => void;
    const held = new Promise<void>((resolve) => {
      commitSuspension = resolve;
    });
    let suspensionLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      suspensionLockAcquired = resolve;
    });

    const suspension = suspender.database.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      await tx
        .update(selections)
        .set({ status: "SUSPENDED" })
        .where(eq(selections.marketId, market.marketId));
      suspensionLockAcquired();
      await held; // keep the transaction open, lock still held
    });

    await lockAcquired;

    // Placement starts now. It must block trying to take FOR SHARE on rows
    // the suspending transaction holds exclusively.
    const placement = bettor.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    // Prove it really is blocked, not merely slow.
    await waitForLockWaiter(observer);

    // Now the suspension lands while placement is mid-transaction.
    commitSuspension();
    await suspension;

    // Placement wakes, re-reads status under its own lock, and sees the
    // suspension that committed after it started.
    await expect(placement).rejects.toBeInstanceOf(SelectionUnavailableError);

    // ...and nothing was left behind.
    expect(await setup.wallet.getBalance(walletId)).toBe(1_000_000n);

    const exposureRows = await setup.database
      .select({ total: exposure.totalLiabilityMinor })
      .from(exposure)
      .where(eq(exposure.marketId, market.marketId));
    expect(exposureRows[0]?.total ?? 0n).toBe(0n);

    const placed = await setup.database
      .select({ id: bets.id })
      .from(bets)
      .where(eq(bets.userId, userId));
    expect(placed).toHaveLength(0);
  }, 60_000);

  it("accepts the bet when placement wins the race, and the suspension waits", async () => {
    const setup = context();
    const bettor = context();
    const suspender = context();

    const { userId, walletId } = await createFundedUser(setup, 1_000_000n);
    const market = await seedMarket(setup, { prices: { home: "2.000" } });

    // The mirror image: placement gets there first. The suspension must queue
    // behind it rather than tearing the bet, and the bet stands because it
    // was legitimately accepted before the market closed.
    const placed = await bettor.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    await suspender.database.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      await tx
        .update(selections)
        .set({ status: "SUSPENDED" })
        .where(eq(selections.marketId, market.marketId));
    });

    expect(await setup.wallet.getBalance(walletId)).toBe(900_000n);

    const rows = await setup.database
      .select({ id: bets.id, status: bets.status })
      .from(bets)
      .where(eq(bets.id, placed.betId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("PENDING");
  }, 60_000);
});
