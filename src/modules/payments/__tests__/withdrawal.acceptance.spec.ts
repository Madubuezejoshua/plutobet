import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { users } from "@/modules/users/schema";
import type { AdminActor } from "@/modules/wallet/types";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { withdrawals } from "../schema";
import {
  AccountNotWithdrawableError,
  KycLimitError,
  WithdrawalRejectedError,
  WithdrawalService,
} from "../withdrawal.service";

const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

async function adminActor(ctx: BettingContext, reason = "verified customer"): Promise<AdminActor> {
  const [admin] = await ctx.database
    .insert(users)
    .values({
      email: `${randomUUID()}@admin.test`,
      passwordHash: "test-only-not-an-authentication-hash",
      role: "ADMIN",
    })
    .returning({ id: users.id });
  return {
    type: "ADMIN",
    id: admin!.id,
    ip: "10.0.0.1",
    reason,
    reauthenticatedAt: new Date(),
  };
}

async function setKycLevel(ctx: BettingContext, userId: string, level: number) {
  await ctx.database.update(users).set({ kycLevel: level }).where(eq(users.id, userId));
}

async function refundCount(ctx: BettingContext, walletId: string): Promise<number> {
  const rows = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt.id = le.txn_id
    WHERE le.wallet_id = ${walletId}::uuid
      AND le.direction = 'CREDIT' AND lt.type = 'REFUND'
  `);
  return Number(rows[0]?.n ?? 0);
}

const BANK = { bankCode: "058", accountNumber: "0123456789", accountName: "Test User" };

describe("withdrawal requests", () => {
  it("holds the funds at request time, not at payout", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
    await setKycLevel(ctx, userId, 2);

    const requested = await service.requestWithdrawal({
      userId,
      walletId,
      amountMinor: 2_000_000n,
      ...BANK,
      ip: "102.89.0.1",
      idempotencyKey: `test:wd:${randomUUID()}`,
    });

    // The money is out of spendable balance immediately — otherwise it could
    // be staked again while the transfer is in flight.
    expect(await ctx.wallet.getBalance(walletId)).toBe(8_000_000n);
    expect(requested.status).toBe("REQUESTED");

    const [row] = await ctx.database
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.id, requested.withdrawalId));
    expect(row!.debitTxnId).toBe(requested.debitTxnId);
  }, 120_000);

  it("refuses to withdraw more than the balance, leaving no request behind", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 100_000n);
    await setKycLevel(ctx, userId, 2);

    await expect(
      service.requestWithdrawal({
        userId,
        walletId,
        amountMinor: 5_000_000n,
        ...BANK,
        ip: "102.89.0.1",
        idempotencyKey: `test:wd:${randomUUID()}`,
      }),
    ).rejects.toThrow();

    expect(await ctx.wallet.getBalance(walletId)).toBe(100_000n);
    const rows = await ctx.database
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.userId, userId));
    expect(rows).toHaveLength(0);
  }, 120_000);

  it("blocks an unverified account from cashing out at all", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
    await setKycLevel(ctx, userId, 0);

    await expect(
      service.requestWithdrawal({
        userId,
        walletId,
        amountMinor: 100_000n,
        ...BANK,
        ip: "102.89.0.1",
        idempotencyKey: `test:wd:${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(KycLimitError);
    expect(await ctx.wallet.getBalance(walletId)).toBe(10_000_000n);
  }, 120_000);

  it("enforces the rolling daily cap for the KYC level", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 100_000_000n);
    await setKycLevel(ctx, userId, 1); // ₦50,000 per 24h

    await service.requestWithdrawal({
      userId,
      walletId,
      amountMinor: 4_000_000n,
      ...BANK,
      ip: "102.89.0.1",
      idempotencyKey: `test:wd:${randomUUID()}`,
    });

    // Would take the rolling total past the level-1 cap.
    await expect(
      service.requestWithdrawal({
        userId,
        walletId,
        amountMinor: 2_000_000n,
        ...BANK,
        ip: "102.89.0.1",
        idempotencyKey: `test:wd:${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(KycLimitError);

    expect(await ctx.wallet.getBalance(walletId)).toBe(96_000_000n);
  }, 120_000);

  it("lets a self-excluded user take their own money out", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
    await setKycLevel(ctx, userId, 2);
    await ctx.database.update(users).set({ status: "SELF_EXCLUDED" }).where(eq(users.id, userId));

    // Self-exclusion stops betting, not cashing out — trapping the balance
    // would penalise someone for using the protection.
    const requested = await service.requestWithdrawal({
      userId,
      walletId,
      amountMinor: 1_000_000n,
      ...BANK,
      ip: "102.89.0.1",
      idempotencyKey: `test:wd:${randomUUID()}`,
    });
    expect(requested.status).toBe("REQUESTED");
  }, 120_000);

  it("blocks a suspended account from withdrawing", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
    await setKycLevel(ctx, userId, 2);
    await ctx.database.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, userId));

    await expect(
      service.requestWithdrawal({
        userId,
        walletId,
        amountMinor: 1_000_000n,
        ...BANK,
        ip: "102.89.0.1",
        idempotencyKey: `test:wd:${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(AccountNotWithdrawableError);
  }, 120_000);
});

describe("withdrawal lifecycle", () => {
  async function requested(ctx: BettingContext, service: WithdrawalService) {
    const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
    await setKycLevel(ctx, userId, 2);
    const record = await service.requestWithdrawal({
      userId,
      walletId,
      amountMinor: 1_000_000n,
      ...BANK,
      ip: "102.89.0.1",
      idempotencyKey: `test:wd:${randomUUID()}`,
    });
    return { userId, walletId, record };
  }

  it("pays out once, and a replayed callback does not pay again", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { walletId, record } = await requested(ctx, service);
    const admin = await adminActor(ctx);

    await service.approve(record.withdrawalId, admin);
    await ctx.database
      .update(withdrawals)
      .set({ status: "PROCESSING", provider: "paystack" })
      .where(eq(withdrawals.id, record.withdrawalId));

    const first = await service.reconcile(record.withdrawalId, { status: "PAID" });
    expect(first.duplicate).toBe(false);

    // §7: a withdrawal must never be processed twice from one request.
    for (let i = 0; i < 5; i++) {
      expect((await service.reconcile(record.withdrawalId, { status: "PAID" })).duplicate).toBe(
        true,
      );
    }

    // Balance moved exactly once, at request time. No refunds.
    expect(await ctx.wallet.getBalance(walletId)).toBe(9_000_000n);
    expect(await refundCount(ctx, walletId)).toBe(0);
  }, 120_000);

  it("returns the money when the transfer fails, exactly once", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { walletId, record } = await requested(ctx, service);
    const admin = await adminActor(ctx);

    await service.approve(record.withdrawalId, admin);
    await ctx.database
      .update(withdrawals)
      .set({ status: "PROCESSING", provider: "paystack" })
      .where(eq(withdrawals.id, record.withdrawalId));

    await service.reconcile(record.withdrawalId, {
      status: "FAILED",
      failureReason: "account closed",
    });
    for (let i = 0; i < 3; i++) {
      await service.reconcile(record.withdrawalId, { status: "FAILED" });
    }

    expect(await ctx.wallet.getBalance(walletId)).toBe(10_000_000n);
    expect(await refundCount(ctx, walletId)).toBe(1);
  }, 120_000);

  it("refunds a rejected request and records who rejected it and why", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { walletId, record } = await requested(ctx, service);
    const admin = await adminActor(ctx, "failed AML review");

    await service.reject(record.withdrawalId, admin);

    expect(await ctx.wallet.getBalance(walletId)).toBe(10_000_000n);
    const [row] = await ctx.database
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.id, record.withdrawalId));
    expect(row!.status).toBe("REJECTED");
    expect(row!.approvedBy).toBe(admin.id);
    expect(row!.refundTxnId).not.toBeNull();

    // §3.14: the admin action has its own audit row, separate from the ledger.
    const audits = await ctx.database.execute<{ n: number; reason: string }>(sql`
      SELECT count(*)::int AS n, min(reason) AS reason FROM audit_log
      WHERE entity = 'withdrawals' AND entity_id = ${record.withdrawalId}
        AND action = 'WITHDRAWAL_REJECTED'
    `);
    expect(Number(audits[0]!.n)).toBe(1);
    expect(audits[0]!.reason).toBe("failed AML review");
  }, 120_000);

  it("requires a reason for an admin approval", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { record } = await requested(ctx, service);
    const admin = await adminActor(ctx, "   ");

    await expect(service.approve(record.withdrawalId, admin)).rejects.toBeInstanceOf(
      WithdrawalRejectedError,
    );
  }, 120_000);

  it("refuses an illegal state transition", async () => {
    const ctx = context();
    const service = new WithdrawalService(ctx.wallet);
    const { record } = await requested(ctx, service);

    // REQUESTED cannot jump straight to PAID.
    await expect(
      service.reconcile(record.withdrawalId, { status: "PAID" }),
    ).rejects.toBeInstanceOf(WithdrawalRejectedError);

    // And the database refuses it too, independently of the service.
    await expect(
      ctx.database
        .update(withdrawals)
        .set({ status: "PAID" })
        .where(eq(withdrawals.id, record.withdrawalId)),
    ).rejects.toThrow();
  }, 120_000);
});
