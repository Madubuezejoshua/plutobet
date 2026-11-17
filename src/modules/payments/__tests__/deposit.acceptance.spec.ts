import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { DepositService, UnattributableDepositError } from "../deposit.service";
import type { DepositWebhookEvent } from "../provider";
import { paymentIntents, virtualAccounts } from "../schema";

const PROVIDER = "paystack";

const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

function webhook(overrides: Partial<DepositWebhookEvent> = {}): DepositWebhookEvent {
  return {
    providerRef: `ref_${randomUUID()}`,
    amountMinor: 500_000n, // ₦5,000.00
    status: "SUCCEEDED",
    raw: { event: "charge.success" },
    ...overrides,
  };
}

async function attachVirtualAccount(
  ctx: BettingContext,
  userId: string,
): Promise<string> {
  const providerRef = `dva_${randomUUID()}`;
  await ctx.database.insert(virtualAccounts).values({
    userId,
    provider: PROVIDER,
    providerRef,
    accountNumber: "9012345678",
    accountName: "Test User",
    bankName: "Wema Bank",
  });
  return providerRef;
}

async function depositCreditCount(ctx: BettingContext, walletId: string): Promise<number> {
  const rows = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt.id = le.txn_id
    WHERE le.wallet_id = ${walletId}::uuid
      AND le.direction = 'CREDIT'
      AND lt.type = 'DEPOSIT'
  `);
  return Number(rows[0]?.n ?? 0);
}

describe("deposit webhooks", () => {
  // THE PHASE 5 ACCEPTANCE CRITERION.
  it("credits the wallet exactly once when the same webhook fires 10 times", async () => {
    const ctx = context();
    const deposits = new DepositService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 0n);
    const dva = await attachVirtualAccount(ctx, userId);

    const event = webhook({ virtualAccountRef: dva, amountMinor: 500_000n });

    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await deposits.applyDepositWebhook(PROVIDER, event));
    }

    // ₦5,000 once. Ten credits would read 5,000,000.
    expect(await ctx.wallet.getBalance(walletId)).toBe(500_000n);
    expect(await depositCreditCount(ctx, walletId)).toBe(1);

    // First delivery did the work; the other nine reported themselves as
    // duplicates rather than silently doing nothing.
    expect(results[0]!.duplicate).toBe(false);
    expect(results.slice(1).every((r) => r.duplicate)).toBe(true);

    // All ten resolve to the same ledger transaction.
    const txnIds = new Set(results.map((r) => r.creditedTxnId));
    expect(txnIds.size).toBe(1);

    const intents = await ctx.database
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.providerRef, event.providerRef));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.status).toBe("SUCCEEDED");
  }, 120_000);

  it("credits once even when ten deliveries arrive concurrently", async () => {
    // Ten separate connections, so these genuinely race in the database
    // rather than queueing on one client — the retry storm a provider
    // actually produces after a timeout.
    const racers = Array.from({ length: 10 }, () => context());
    const setup = racers[0]!;
    const { userId, walletId } = await createFundedUser(setup, 0n);
    const dva = await attachVirtualAccount(setup, userId);
    const event = webhook({ virtualAccountRef: dva, amountMinor: 250_000n });

    const outcomes = await Promise.allSettled(
      racers.map((ctx) => new DepositService(ctx.wallet).applyDepositWebhook(PROVIDER, event)),
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    // Some may fail on write contention; what must never happen is a second
    // credit.
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(await ctx0Balance(setup, walletId)).toBe(250_000n);
    expect(await depositCreditCount(setup, walletId)).toBe(1);
  }, 180_000);

  it("does not credit a failed charge", async () => {
    const ctx = context();
    const deposits = new DepositService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 0n);
    const dva = await attachVirtualAccount(ctx, userId);

    const result = await deposits.applyDepositWebhook(
      PROVIDER,
      webhook({ virtualAccountRef: dva, status: "FAILED" }),
    );

    expect(result.creditedTxnId).toBeNull();
    expect(await ctx.wallet.getBalance(walletId)).toBe(0n);
  }, 120_000);

  it("holds a pending charge without crediting, then credits when it succeeds", async () => {
    const ctx = context();
    const deposits = new DepositService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 0n);
    const dva = await attachVirtualAccount(ctx, userId);
    const ref = `ref_${randomUUID()}`;

    await deposits.applyDepositWebhook(
      PROVIDER,
      webhook({ providerRef: ref, virtualAccountRef: dva, status: "PENDING" }),
    );
    expect(await ctx.wallet.getBalance(walletId)).toBe(0n);

    await deposits.applyDepositWebhook(
      PROVIDER,
      webhook({ providerRef: ref, virtualAccountRef: dva, status: "SUCCEEDED" }),
    );
    expect(await ctx.wallet.getBalance(walletId)).toBe(500_000n);
    expect(await depositCreditCount(ctx, walletId)).toBe(1);
  }, 120_000);

  it("refuses a deposit it cannot attribute rather than guessing a wallet", async () => {
    const ctx = context();
    const deposits = new DepositService(ctx.wallet);

    await expect(
      deposits.applyDepositWebhook(PROVIDER, webhook({ virtualAccountRef: "dva_unknown" })),
    ).rejects.toBeInstanceOf(UnattributableDepositError);
  }, 120_000);

  it("credits the amount recorded on the intent, not a later corrected figure", async () => {
    const ctx = context();
    const deposits = new DepositService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 0n);
    const dva = await attachVirtualAccount(ctx, userId);
    const ref = `ref_${randomUUID()}`;

    await deposits.applyDepositWebhook(
      PROVIDER,
      webhook({ providerRef: ref, virtualAccountRef: dva, amountMinor: 500_000n }),
    );

    // A replay claiming a different amount must not move more money.
    await deposits.applyDepositWebhook(
      PROVIDER,
      webhook({ providerRef: ref, virtualAccountRef: dva, amountMinor: 9_999_999n }),
    );

    expect(await ctx.wallet.getBalance(walletId)).toBe(500_000n);
    expect(await depositCreditCount(ctx, walletId)).toBe(1);
  }, 120_000);
});

async function ctx0Balance(ctx: BettingContext, walletId: string): Promise<bigint> {
  return ctx.wallet.getBalance(walletId);
}
