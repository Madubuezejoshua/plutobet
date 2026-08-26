import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundedUserWallet, makeTestContext } from "./test-helpers";
import { InsufficientFundsError } from "./wallet.types";

const { prisma, wallets } = makeTestContext();

describe("WalletService concurrency", () => {
  beforeAll(async () => {
    await prisma.$connect();

    // Prisma opens pool connections lazily, on demand — $connect() only
    // establishes one. Without warming, run 1 absorbs the cost of opening
    // the whole pool at once, and a wide simultaneous burst of brand-new TCP
    // connections is exactly what Windows drops (a TCP-layer accident, not a
    // locking bug — but it still means run 1 sees a stray infra error rather
    // than a clean InsufficientFundsError). Warm in small batches so the
    // pool ramps instead of stampeding.
    for (let i = 0; i < 5; i++) {
      await Promise.all(Array.from({ length: 5 }, () => prisma.$queryRaw`SELECT 1`));
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const STAKE = 1_000n; // kobo
  const RUNS = 20;

  // Phase 1 acceptance criterion: fire 100 concurrent debit() calls at a
  // wallet funded for exactly 60 of them. Must get exactly 60 successes, 40
  // clean InsufficientFundsError rejections, and a final balance of exactly
  // zero — every time. If FOR UPDATE locking is wrong (lost updates, a
  // stale read winning a race), this is where it shows up: as a nonzero
  // final balance or a success/rejection count that isn't 60/40.
  it.each(Array.from({ length: RUNS }, (_, i) => i + 1))(
    "settles 100 concurrent debits to exactly zero (run %i/" + RUNS + ")",
    async () => {
      const walletId = await fundedUserWallet(prisma, STAKE * 60n);

      const results = await Promise.allSettled(
        Array.from({ length: 100 }, () =>
          wallets.debit({
            walletId,
            amountMinor: STAKE,
            counterparty: "stakes_liability",
            type: "stake",
            // Distinct key per call — this test is about lock correctness,
            // not idempotency, so each of the 100 must be a genuinely new
            // operation rather than 99 replays of the first.
            idempotencyKey: `test:${randomUUID()}`,
            actor: { type: "system" },
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(InsufficientFundsError);
      }

      expect(fulfilled).toHaveLength(60);
      expect(rejected).toHaveLength(40);

      const finalBalance = await wallets.getBalance(walletId);
      expect(finalBalance).toBe(0n);
    },
  );
});
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
