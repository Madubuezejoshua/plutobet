import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeWalletTestContexts,
  createWalletTestContext,
  createZeroBalanceWallet,
  replayWallet,
  testKey,
  type WalletTestContext,
} from "./helpers";

const operationSequence = fc.array(
  fc.record({
    direction: fc.constantFrom<"CREDIT" | "DEBIT">("CREDIT", "DEBIT"),
    amount: fc.integer({ min: 1, max: 25_000 }),
  }),
  { minLength: 1, maxLength: 15 },
);

describe("wallet ledger property acceptance", () => {
  let context: WalletTestContext;

  beforeAll(() => {
    context = createWalletTestContext();
  });

  afterAll(async () => {
    await closeWalletTestContexts([context]);
  });

  it("keeps every generated valid credit/debit sequence reconstructible", async () => {
    await fc.assert(
      fc.asyncProperty(operationSequence, async (steps) => {
        const walletId = await createZeroBalanceWallet(context);
        let expectedBalance = 0n;

        for (const [index, step] of steps.entries()) {
          const rawAmount = BigInt(step.amount);
          if (step.direction === "CREDIT" || expectedBalance === 0n) {
            const result = await context.wallet.credit({
              walletId,
              amountMinor: rawAmount,
              type: "DEPOSIT",
              idempotencyKey: testKey(`property:credit:${index}`),
              actor: { type: "SYSTEM" },
            });
            expectedBalance += rawAmount;
            expect(result.balanceAfterMinor).toBe(expectedBalance);
          } else {
            // Convert the random magnitude into [1, current balance], making
            // the generated debit valid without weakening the service's
            // non-negative balance invariant.
            const amountMinor = ((rawAmount - 1n) % expectedBalance) + 1n;
            const result = await context.wallet.debit({
              walletId,
              amountMinor,
              type: "STAKE",
              idempotencyKey: testKey(`property:debit:${index}`),
              actor: { type: "SYSTEM" },
            });
            expectedBalance -= amountMinor;
            expect(result.balanceAfterMinor).toBe(expectedBalance);
          }
        }

        const cachedBalance = await context.wallet.getBalance(walletId);
        expect(cachedBalance).toBe(expectedBalance);
        expect(await replayWallet(context, walletId)).toBe(cachedBalance);

        const statement = await context.wallet.getStatement(walletId, { limit: 100 });
        expect(statement.nextCursor).toBeNull();
        expect(statement.entries.map((entry) => entry.walletVersion)).toEqual(
          Array.from(
            { length: steps.length },
            (_, index) => BigInt(steps.length - index),
          ),
        );
        expect(statement.entries[0]?.balanceAfterMinor).toBe(expectedBalance);
      }),
      { numRuns: 30 },
    );
  });

  it("paginates statements without gaps by monotonic wallet version", async () => {
    const walletId = await createZeroBalanceWallet(context);
    for (const [index, amountMinor] of [100n, 200n, 300n, 400n, 500n].entries()) {
      await context.wallet.credit({
        walletId,
        amountMinor,
        type: "DEPOSIT",
        idempotencyKey: testKey(`statement:${index}`),
        actor: { type: "SYSTEM" },
      });
    }

    const first = await context.wallet.getStatement(walletId, { limit: 2 });
    expect(first.entries.map((entry) => entry.walletVersion)).toEqual([5n, 4n]);
    expect(first.nextCursor).toEqual({ walletVersion: 4n });

    const second = await context.wallet.getStatement(walletId, {
      limit: 2,
      before: first.nextCursor!,
    });
    expect(second.entries.map((entry) => entry.walletVersion)).toEqual([3n, 2n]);
    expect(second.nextCursor).toEqual({ walletVersion: 2n });

    const third = await context.wallet.getStatement(walletId, {
      limit: 2,
      before: second.nextCursor!,
    });
    expect(third.entries.map((entry) => entry.walletVersion)).toEqual([1n]);
    expect(third.nextCursor).toBeNull();
  });
});
