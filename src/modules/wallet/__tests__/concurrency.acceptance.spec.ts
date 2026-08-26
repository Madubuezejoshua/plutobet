import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InsufficientFundsError } from "../errors";
import {
  closeWalletTestContexts,
  createLedgerFundedWallet,
  createWalletWorkerPool,
  operationEvidence,
  replayWallet,
  testKey,
  type WalletTestContext,
} from "./helpers";

describe("wallet concurrency acceptance", () => {
  let workers: WalletTestContext[];

  beforeAll(() => {
    // Each context owns an independent postgres-js client configured max:1.
    // This models concurrent serverless instances instead of multiplexing all
    // calls through one in-process pool.
    workers = createWalletWorkerPool(16);
  });

  afterAll(async () => {
    await closeWalletTestContexts(workers);
  });

  it("runs the 100-debit 60/40 hammer twenty times without drift", async () => {
    const stakeMinor = 1_000n;

    for (let run = 0; run < 20; run += 1) {
      const walletId = await createLedgerFundedWallet(workers[0]!, stakeMinor * 60n);
      const results = await Promise.allSettled(
        Array.from({ length: 100 }, (_, index) =>
          workers[index % workers.length]!.wallet.debit({
            walletId,
            amountMinor: stakeMinor,
            type: "STAKE",
            idempotencyKey: testKey(`hammer:${run}:${index}`),
            actor: { type: "SYSTEM" },
          }),
        ),
      );

      const succeeded = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );

      expect(succeeded, `hammer run ${run + 1}: successes`).toHaveLength(60);
      expect(rejected, `hammer run ${run + 1}: rejections`).toHaveLength(40);
      for (const result of rejected) {
        expect(result.reason, `hammer run ${run + 1}: rejection type`).toBeInstanceOf(
          InsufficientFundsError,
        );
      }

      const cached = await workers[0]!.wallet.getBalance(walletId);
      const replayed = await replayWallet(workers[0]!, walletId);
      expect(cached, `hammer run ${run + 1}: cached balance`).toBe(0n);
      expect(replayed, `hammer run ${run + 1}: replayed balance`).toBe(cached);

      const statement = await workers[0]!.wallet.getStatement(walletId, { limit: 100 });
      expect(
        statement.entries.map((entry) => entry.walletVersion),
        `hammer run ${run + 1}: monotonic wallet versions`,
      ).toEqual(
        Array.from({ length: 61 }, (_, index) => BigInt(61 - index)),
      );
    }
  });

  it("fires one idempotency key fifty times but writes one balanced transaction and audit", async () => {
    const walletId = await createLedgerFundedWallet(workers[0]!, 10_000n);
    const idempotencyKey = testKey("idempotency-50");

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        workers[index % workers.length]!.wallet.debit({
          walletId,
          amountMinor: 3_000n,
          type: "STAKE",
          idempotencyKey,
          actor: { type: "SYSTEM" },
          metadata: { betId: "stable-bet-id" },
        }),
      ),
    );

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotent)).toHaveLength(1);
    expect(results.filter((result) => result.idempotent)).toHaveLength(49);
    expect(results.every((result) => result.balanceAfterMinor === 7_000n)).toBe(true);

    const evidence = await operationEvidence(workers[0]!, idempotencyKey);
    expect(evidence.transactions).toBe(1);
    expect(evidence.legs).toBe(2);
    expect(evidence.audits).toBe(1);
    expect(await workers[0]!.wallet.getBalance(walletId)).toBe(7_000n);
    expect(await replayWallet(workers[0]!, walletId)).toBe(7_000n);
  });

  it("locks opposite-direction transfers in one deterministic order", async () => {
    const firstWalletId = await createLedgerFundedWallet(workers[0]!, 100_000n);
    const secondWalletId = await createLedgerFundedWallet(workers[0]!, 100_000n);

    const transfers = Array.from({ length: 40 }, (_, index) => {
      const forward = index % 2 === 0;
      return workers[index % workers.length]!.wallet.transfer({
        fromWalletId: forward ? firstWalletId : secondWalletId,
        toWalletId: forward ? secondWalletId : firstWalletId,
        amountMinor: 500n,
        idempotencyKey: testKey(`opposite-transfer:${index}`),
        actor: { type: "SYSTEM" },
      });
    });

    const results = await Promise.all(transfers);
    expect(results).toHaveLength(40);
    expect(await workers[0]!.wallet.getBalance(firstWalletId)).toBe(100_000n);
    expect(await workers[0]!.wallet.getBalance(secondWalletId)).toBe(100_000n);
    expect(await replayWallet(workers[0]!, firstWalletId)).toBe(100_000n);
    expect(await replayWallet(workers[0]!, secondWalletId)).toBe(100_000n);
  });
});
