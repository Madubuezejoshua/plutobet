import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { InsufficientFundsError, WalletContentionError, WalletError } from "../errors";
import {
  closeWalletTestContexts,
  createLedgerFundedWallet,
  createWalletWorkerPool,
  testKey,
  type WalletTestContext,
} from "./helpers";

/**
 * A wallet row lock that cannot be taken must surface as a TYPED error.
 *
 * Regression for a defect found by the 100-way concurrency hammer: on one run
 * a rejection arrived as a raw postgres driver error rather than a wallet
 * error. Money integrity was intact — the balance still reconciled — but the
 * error reached the API unmapped, which means an opaque 500 for a customer
 * placing a bet during a burst, and no way for any caller to tell "retry in a
 * moment" apart from a genuine fault.
 *
 * The lock timeout is deliberately dropped to milliseconds here. Waiting the
 * production 30s would make this test unrunnable, and the code path being
 * proven is identical either way.
 */

const workers: WalletTestContext[] = createWalletWorkerPool(2);
const SAVED_TIMEOUT = process.env.WALLET_LOCK_TIMEOUT;

afterEach(() => {
  if (SAVED_TIMEOUT === undefined) delete process.env.WALLET_LOCK_TIMEOUT;
  else process.env.WALLET_LOCK_TIMEOUT = SAVED_TIMEOUT;
});

afterAll(async () => {
  await closeWalletTestContexts(workers);
});

describe("wallet lock contention", () => {
  it("raises WalletContentionError, not a raw driver error, when the lock times out", async () => {
    const holder = workers[0]!;
    const contender = workers[1]!;
    const walletId = await createLedgerFundedWallet(holder, 100_000n);

    process.env.WALLET_LOCK_TIMEOUT = "50ms";

    // Hold the row lock in one connection while another tries to debit it.
    // `release` is resolved in the finally block so the lock is never left
    // held if the assertion throws — a stuck lock would hang the whole file.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holding = holder.database.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId}::uuid FOR UPDATE`);
      await held;
    });

    try {
      // Give the holder a moment to actually take the lock before contending.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const attempt = contender.wallet.debit({
        walletId,
        amountMinor: 1_000n,
        type: "STAKE",
        idempotencyKey: testKey("contention-timeout"),
        actor: { type: "SYSTEM" },
      });

      await expect(attempt).rejects.toBeInstanceOf(WalletContentionError);
      await expect(attempt).rejects.toBeInstanceOf(WalletError);

      // The message must tell the caller retrying is safe. It is, because the
      // transaction never got past its lock, so nothing was written.
      await attempt.catch((error: unknown) => {
        expect((error as Error).message).toMatch(/retry is safe/i);
        expect((error as WalletContentionError).pgCode).toBe("55P03");
      });
    } finally {
      release();
      await holding;
    }

    // Nothing was written, and the balance is untouched.
    expect(await holder.wallet.getBalance(walletId)).toBe(100_000n);
  });

  it("still raises InsufficientFundsError when the lock is free but the money is not", async () => {
    // The mapping must not swallow ordinary business failures. Without this,
    // classifying too broadly would turn "you cannot afford this" into
    // "the wallet is busy", and the customer would retry forever.
    const worker = workers[0]!;
    const walletId = await createLedgerFundedWallet(worker, 500n);

    await expect(
      worker.wallet.debit({
        walletId,
        amountMinor: 10_000n,
        type: "STAKE",
        idempotencyKey: testKey("contention-insufficient"),
        actor: { type: "SYSTEM" },
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await worker.wallet.getBalance(walletId)).toBe(500n);
  });

  it("ignores a malformed WALLET_LOCK_TIMEOUT rather than injecting it", async () => {
    // The value reaches SET LOCAL, which takes no bind parameters, so it is
    // string-interpolated. Anything not matching the pattern must fall back to
    // the default instead of reaching the server.
    process.env.WALLET_LOCK_TIMEOUT = "1s'; DROP TABLE wallets; --";

    const worker = workers[0]!;
    const walletId = await createLedgerFundedWallet(worker, 5_000n);

    const result = await worker.wallet.debit({
      walletId,
      amountMinor: 1_000n,
      type: "STAKE",
      idempotencyKey: testKey("contention-injection"),
      actor: { type: "SYSTEM" },
    });

    expect(result.balanceAfterMinor).toBe(4_000n);

    const rows = await worker.database.execute<{ present: boolean }>(
      sql`SELECT to_regclass('public.wallets') IS NOT NULL AS present`,
    );
    expect(rows[0]?.present, "the wallets table was dropped").toBe(true);
  });
});
