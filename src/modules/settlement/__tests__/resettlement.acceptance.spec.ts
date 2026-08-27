import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ResettlementError, ResettlementService } from "../resettlement.service";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";

/**
 * Correcting a settled bet.
 *
 * The rule under test throughout: a resettlement NEVER edits the original
 * movement, it posts a compensating one. The original settlement stays in the
 * ledger exactly as it happened.
 */
describe("resettlement", () => {
  let context: BettingContext;
  let service: ResettlementService;

  const IP = "102.89.0.1";

  beforeAll(() => {
    context = createBettingContext();
    service = new ResettlementService(context.wallet);
  });

  afterAll(async () => {
    await closeBettingContexts([context]);
  });

  /**
   * Places a real bet, then settles it by hand to the given outcome.
   *
   * Goes through the ACTUAL placement path rather than inserting a bet row.
   * An earlier version hand-built the row and was rejected by a deferred
   * constraint requiring every bet to have legs — the schema was right, and
   * a fixture that sidesteps invariants would be testing a shape that cannot
   * exist in production.
   */
  async function settledBet(params: {
    payoutMinor: bigint;
    status: "WON" | "LOST";
    fundingMinor?: bigint;
  }): Promise<{ betId: string; userId: string; walletId: string }> {
    const funding = params.fundingMinor ?? 1_000_000n;
    const { userId, walletId } = await createFundedUser(context, funding);
    const market = await seedMarket(context);

    const placed = await context.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 10_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    await context.database.execute(sql`
      UPDATE bets SET status = ${params.status}::bet_status, settled_at = now()
      WHERE id = ${placed.betId}::uuid
    `);

    // The settlement credit carries the metadata the resettlement service
    // reads to discover what was originally paid.
    if (params.payoutMinor > 0n) {
      await context.wallet.credit({
        walletId,
        amountMinor: params.payoutMinor,
        type: "PAYOUT",
        idempotencyKey: `settlement:won:${placed.betId}`,
        actor: { type: "SYSTEM" },
        metadata: { kind: "BET_SETTLEMENT", betId: placed.betId, outcome: "WON" },
      });
    }

    return { betId: placed.betId, userId, walletId };
  }

  async function balance(walletId: string): Promise<bigint> {
    return context.wallet.getBalance(walletId);
  }

  async function adminId(): Promise<string> {
    return context.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO users (email, password_hash, role)
        VALUES (${`${randomUUID()}@admin.test`}, 'test-only-not-a-real-hash', 'ADMIN')
        RETURNING id
      `);
      return row!.id;
    });
  }

  it("credits a customer who was underpaid", async () => {
    const bet = await settledBet({ status: "LOST", payoutMinor: 0n, fundingMinor: 20_000n });
    const admin = await adminId();

    const before = await balance(bet.walletId);

    const result = await service.resettle({
      betId: bet.betId,
      newStatus: "WON",
      newPayoutMinor: 20_000n,
      reason: "PROVIDER_CORRECTION",
      note: "provider posted a corrected score",
      authorisedBy: admin,
      ip: IP,
    });

    expect(result.adjustmentMinor).toBe(20_000n);
    expect(result.shortfallMinor).toBe(0n);
    expect(await balance(bet.walletId)).toBe(before + 20_000n);
  });

  it("claws back from a customer who was overpaid", async () => {
    const bet = await settledBet({ status: "WON", payoutMinor: 20_000n });
    const admin = await adminId();

    const before = await balance(bet.walletId);

    const result = await service.resettle({
      betId: bet.betId,
      newStatus: "LOST",
      newPayoutMinor: 0n,
      reason: "PROVIDER_CORRECTION",
      note: "goal disallowed on review",
      authorisedBy: admin,
      ip: IP,
    });

    expect(result.adjustmentMinor).toBe(-20_000n);
    expect(result.recoveredMinor).toBe(20_000n);
    expect(result.shortfallMinor).toBe(0n);
    expect(await balance(bet.walletId)).toBe(before - 20_000n);
  });

  /*
   * The case that actually happens. Someone is wrongly paid, spends it, and
   * the correction arrives after the money is gone.
   *
   * The wallet cannot go negative — a CHECK enforces it — and the alternatives
   * to recording a shortfall are both worse: failing the correction leaves the
   * books wrong, and inventing a negative balance is something the database
   * would reject anyway.
   */
  it("recovers what it can and records the rest as a shortfall", async () => {
    // Funded to exactly the stake, so the payout is the whole balance and
    // spending it leaves too little to claw back in full.
    const bet = await settledBet({
      status: "WON",
      payoutMinor: 20_000n,
      fundingMinor: 10_000n,
    });

    // The customer spends most of it before the correction lands.
    await context.wallet.debit({
      walletId: bet.walletId,
      amountMinor: 15_000n,
      type: "STAKE",
      idempotencyKey: `spend:${randomUUID()}`,
      actor: { type: "SYSTEM" },
    });
    expect(await balance(bet.walletId)).toBe(5_000n);

    const admin = await adminId();
    const result = await service.resettle({
      betId: bet.betId,
      newStatus: "LOST",
      newPayoutMinor: 0n,
      reason: "OPERATOR_ERROR",
      note: "settled against the wrong market",
      authorisedBy: admin,
      ip: IP,
    });

    expect(result.adjustmentMinor).toBe(-20_000n);
    expect(result.recoveredMinor).toBe(5_000n);
    expect(result.shortfallMinor).toBe(15_000n);
    // Recovered to zero, never below it.
    expect(await balance(bet.walletId)).toBe(0n);
  });

  it("records the correction and marks the bet as resettled", async () => {
    const bet = await settledBet({ status: "WON", payoutMinor: 20_000n });
    const admin = await adminId();

    await service.resettle({
      betId: bet.betId,
      newStatus: "VOID",
      newPayoutMinor: 10_000n,
      reason: "MATCH_AWARDED",
      note: "match awarded after appeal",
      authorisedBy: admin,
      ip: IP,
    });

    const history = await service.history(bet.betId);
    expect(history).toHaveLength(1);
    expect(history[0]!.previousStatus).toBe("WON");
    expect(history[0]!.newStatus).toBe("VOID");
    expect(history[0]!.adjustmentMinor).toBe(-10_000n);

    const [row] = await context.database.execute<{ status: string; n: number }>(sql`
      SELECT status::text AS status, resettlement_count AS n
      FROM bets WHERE id = ${bet.betId}::uuid
    `);
    expect(row!.status).toBe("VOID");
    expect(Number(row!.n)).toBe(1);
  });

  /*
   * The original settlement must survive the correction. "We paid this, then
   * corrected it" is the true account; "we never paid it" is not, and a
   * regulator asking what happened needs the first one.
   */
  it("leaves the original settlement entry untouched", async () => {
    const bet = await settledBet({ status: "WON", payoutMinor: 20_000n });
    const admin = await adminId();

    await service.resettle({
      betId: bet.betId,
      newStatus: "LOST",
      newPayoutMinor: 0n,
      reason: "PROVIDER_CORRECTION",
      note: "corrected score",
      authorisedBy: admin,
      ip: IP,
    });

    const entries = await context.database.execute<{ type: string; direction: string }>(sql`
      SELECT lt.type::text AS type, le.direction::text AS direction
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.txn_id
      WHERE le.wallet_id = ${bet.walletId}::uuid
      ORDER BY le.wallet_version
    `);

    // The PAYOUT credit is still there, and the correction is a SEPARATE
    // ADJUSTMENT debit rather than an edit of it.
    expect(entries.some((e) => e.type === "PAYOUT" && e.direction === "CREDIT")).toBe(true);
    expect(entries.some((e) => e.type === "ADJUSTMENT" && e.direction === "DEBIT")).toBe(true);
  });

  it("replays rather than correcting twice on a repeated call", async () => {
    const bet = await settledBet({ status: "LOST", payoutMinor: 0n, fundingMinor: 20_000n });
    const startingBalance = await balance(bet.walletId);
    const admin = await adminId();

    const first = await service.resettle({
      betId: bet.betId,
      newStatus: "WON",
      newPayoutMinor: 20_000n,
      reason: "PROVIDER_CORRECTION",
      note: "corrected score",
      authorisedBy: admin,
      ip: IP,
    });

    // Same correction again. The idempotency key is derived from the bet and
    // the new payout, so the money moves once.
    await service
      .resettle({
        betId: bet.betId,
        newStatus: "WON",
        newPayoutMinor: 20_000n,
        reason: "PROVIDER_CORRECTION",
        note: "corrected score",
        authorisedBy: admin,
        ip: IP,
      })
      .catch(() => undefined);

    expect(first.adjustmentMinor).toBe(20_000n);
    // Credited once, not twice.
    expect(await balance(bet.walletId)).toBe(startingBalance + 20_000n);
  });

  describe("refusals", () => {
    it("refuses a bet that has not settled", async () => {
      /*
       * A genuinely unsettled bet, not one forced back to PENDING.
       *
       * The first attempt at this test did the latter and was refused by the
       * terminal-status guard -- correctly: reversing a settled bet to PENDING
       * without a resettlement record is precisely what that trigger exists to
       * stop, and a test should not need an escape hatch production does not
       * have.
       */
      const { userId, walletId } = await createFundedUser(context, 1_000_000n);
      const market = await seedMarket(context);
      const placed = await context.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 10_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      });
      const bet = { betId: placed.betId };
      const admin = await adminId();

      await expect(
        service.resettle({
          betId: bet.betId,
          newStatus: "WON",
          newPayoutMinor: 20_000n,
          reason: "PROVIDER_CORRECTION",
          note: "too early",
          authorisedBy: admin,
          ip: IP,
        }),
      ).rejects.toThrow(ResettlementError);
    });

    it("refuses an unknown bet", async () => {
      const admin = await adminId();
      await expect(
        service.resettle({
          betId: randomUUID(),
          newStatus: "WON",
          newPayoutMinor: 1_000n,
          reason: "OPERATOR_ERROR",
          note: "no such bet",
          authorisedBy: admin,
          ip: IP,
        }),
      ).rejects.toThrow(/unknown bet/);
    });

    it("requires a meaningful note", async () => {
      const bet = await settledBet({ status: "WON", payoutMinor: 20_000n });
      const admin = await adminId();

      await expect(
        service.resettle({
          betId: bet.betId,
          newStatus: "LOST",
          newPayoutMinor: 0n,
          reason: "OPERATOR_ERROR",
          note: "x",
          authorisedBy: admin,
          ip: IP,
        }),
      ).rejects.toThrow(RangeError);
    });

    it("refuses a negative payout", async () => {
      const bet = await settledBet({ status: "WON", payoutMinor: 20_000n });
      const admin = await adminId();

      await expect(
        service.resettle({
          betId: bet.betId,
          newStatus: "LOST",
          newPayoutMinor: -1n,
          reason: "OPERATOR_ERROR",
          note: "impossible payout",
          authorisedBy: admin,
          ip: IP,
        }),
      ).rejects.toThrow(RangeError);
    });
  });
});
