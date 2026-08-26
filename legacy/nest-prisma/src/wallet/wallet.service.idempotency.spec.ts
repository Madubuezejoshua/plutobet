import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundedUserWallet, makeTestContext } from "./test-helpers";
import { IdempotencyConflictError, InsufficientFundsError } from "./wallet.types";

const { prisma, wallets } = makeTestContext();

describe("WalletService idempotency & clean rejection", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("replays the same result for a duplicate idempotency key instead of debiting twice", async () => {
    const walletId = await fundedUserWallet(prisma, 10_000n);
    const key = `test:${randomUUID()}`;

    const first = await wallets.debit({
      walletId,
      amountMinor: 3_000n,
      counterparty: "stakes_liability",
      type: "stake",
      idempotencyKey: key,
      actor: { type: "system" },
    });
    expect(first.idempotent).toBe(false);
    expect(first.balanceAfterMinor).toBe(7_000n);

    // Simulates exactly what a retried payment-provider webhook does.
    const second = await wallets.debit({
      walletId,
      amountMinor: 3_000n,
      counterparty: "stakes_liability",
      type: "stake",
      idempotencyKey: key,
      actor: { type: "system" },
    });
    expect(second.idempotent).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balanceAfterMinor).toBe(7_000n);

    // The assertion that actually matters: only debited once.
    expect(await wallets.getBalance(walletId)).toBe(7_000n);
  });

  it("rejects a reused idempotency key with mismatched parameters instead of silently replaying", async () => {
    const walletId = await fundedUserWallet(prisma, 10_000n);
    const key = `test:${randomUUID()}`;

    await wallets.debit({
      walletId,
      amountMinor: 1_000n,
      counterparty: "stakes_liability",
      type: "stake",
      idempotencyKey: key,
      actor: { type: "system" },
    });

    await expect(
      wallets.debit({
        walletId,
        amountMinor: 2_000n, // different amount, same key — a caller bug
        counterparty: "stakes_liability",
        type: "stake",
        idempotencyKey: key,
        actor: { type: "system" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects insufficient funds cleanly: no transaction row persisted, balance untouched, key stays usable", async () => {
    const walletId = await fundedUserWallet(prisma, 500n);
    const key = `test:${randomUUID()}`;

    await expect(
      wallets.debit({
        walletId,
        amountMinor: 10_000n,
        counterparty: "stakes_liability",
        type: "stake",
        idempotencyKey: key,
        actor: { type: "system" },
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await wallets.getBalance(walletId)).toBe(500n);

    const persisted = await prisma.transaction.findUnique({ where: { idempotencyKey: key } });
    expect(persisted).toBeNull();

    // Top up, then prove the SAME key from the failed attempt still works —
    // a clean rejection must not have consumed it.
    await wallets.credit({
      walletId,
      amountMinor: 10_000n,
      counterparty: "bonus_liability",
      type: "bonus",
      idempotencyKey: `${key}:topup`,
      actor: { type: "system" },
    });

    const nowAffordable = await wallets.debit({
      walletId,
      amountMinor: 10_000n,
      counterparty: "stakes_liability",
      type: "stake",
      idempotencyKey: key,
      actor: { type: "system" },
    });
    expect(nowAffordable.idempotent).toBe(false);
    expect(nowAffordable.balanceAfterMinor).toBe(500n);
  });
});
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
