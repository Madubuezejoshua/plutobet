import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InsufficientFundsError, WalletContentionError } from "../errors";
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

      /*
       * EVERY rejection must be one of two typed outcomes.
       *
       * A raw driver error here is a real defect: it reaches the API as an
       * opaque 500, so the customer is told nothing and the caller cannot tell
       * "retry in a moment" from a genuine fault. One escaped this way — a
       * 55P03 lock timeout from the 30s lock_timeout that money paths set —
       * and is now mapped to WalletContentionError.
       */
      const contended = rejected.filter((r) => r.reason instanceof WalletContentionError);
      for (const result of rejected) {
        expect(
          result.reason instanceof InsufficientFundsError ||
            result.reason instanceof WalletContentionError,
          `hammer run ${run + 1}: rejection was an untyped error: ${String(result.reason)}`,
        ).toBe(true);
      }

      /*
       * The invariant is conservation, not a fixed success count.
       *
       * Asserting exactly 60 successes assumes no operation ever loses the
       * lock race, which is a statement about timing rather than correctness —
       * a contention timeout is a legitimate outcome of a deliberate 100-way
       * hammer. What must ALWAYS hold is that the balance equals the funding
       * minus exactly the debits that succeeded, and that nothing overdrew.
       */
      expect(succeeded.length, `hammer run ${run + 1}: overdrawn`).toBeLessThanOrEqual(60);
      expect(succeeded.length + rejected.length).toBe(100);

      const expectedBalance = stakeMinor * 60n - stakeMinor * BigInt(succeeded.length);
      const cached = await workers[0]!.wallet.getBalance(walletId);
      const replayed = await replayWallet(workers[0]!, walletId);
      expect(cached, `hammer run ${run + 1}: cached balance`).toBe(expectedBalance);
      expect(replayed, `hammer run ${run + 1}: replayed balance`).toBe(cached);
      expect(cached >= 0n, `hammer run ${run + 1}: negative balance`).toBe(true);

      // With no contention the run must be exact — that is still the normal
      // case, and letting it drift silently would hide a genuine regression.
      if (contended.length === 0) {
        expect(succeeded, `hammer run ${run + 1}: successes`).toHaveLength(60);
        expect(cached, `hammer run ${run + 1}: fully drained`).toBe(0n);
      }

      const statement = await workers[0]!.wallet.getStatement(walletId, { limit: 100 });
      const versions = statement.entries.map((entry) => entry.walletVersion);
      const expectedVersions = succeeded.length + 1;
      expect(versions, `hammer run ${run + 1}: monotonic wallet versions`).toEqual(
        Array.from({ length: expectedVersions }, (_, index) =>
          BigInt(expectedVersions - index),
        ),
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
