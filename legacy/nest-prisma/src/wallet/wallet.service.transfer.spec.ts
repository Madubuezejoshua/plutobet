import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundedUserWallet, makeTestContext } from "./test-helpers";

const { prisma, wallets } = makeTestContext();

describe("WalletService.transfer", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("moves funds between two user wallets", async () => {
    const a = await fundedUserWallet(prisma, 10_000n);
    const b = await fundedUserWallet(prisma, 0n);

    const result = await wallets.transfer({
      fromWalletId: a,
      toWalletId: b,
      amountMinor: 4_000n,
      type: "adjustment",
      idempotencyKey: `test:${randomUUID()}`,
      actor: { type: "admin", id: randomUUID() },
    });

    expect(result.balanceAfterMinor).toBe(6_000n);
    expect(await wallets.getBalance(a)).toBe(6_000n);
    expect(await wallets.getBalance(b)).toBe(4_000n);
  });

  // The scenario the ascending-id lock order exists for: two transfers in
  // OPPOSITE directions between the same two wallets, fired concurrently.
  // If lock acquisition order depended on which wallet is "from" instead of
  // a fixed global order, this is exactly the shape that deadlocks. Both
  // must complete without erroring, hanging, or needing app-level retry.
  it("does not deadlock on two concurrent opposite-direction transfers", async () => {
    const a = await fundedUserWallet(prisma, 10_000n);
    const b = await fundedUserWallet(prisma, 10_000n);

    const [r1, r2] = await Promise.all([
      wallets.transfer({
        fromWalletId: a,
        toWalletId: b,
        amountMinor: 1_000n,
        type: "adjustment",
        idempotencyKey: `test:${randomUUID()}`,
        actor: { type: "admin", id: randomUUID() },
      }),
      wallets.transfer({
        fromWalletId: b,
        toWalletId: a,
        amountMinor: 500n,
        type: "adjustment",
        idempotencyKey: `test:${randomUUID()}`,
        actor: { type: "admin", id: randomUUID() },
      }),
    ]);

    expect(r1.idempotent).toBe(false);
    expect(r2.idempotent).toBe(false);

    // Net effect is deterministic regardless of interleaving: both transfers
    // succeed unconditionally (neither wallet ever runs short).
    expect(await wallets.getBalance(a)).toBe(9_500n); // 10000 - 1000 + 500
    expect(await wallets.getBalance(b)).toBe(10_500n); // 10000 + 1000 - 500
  }, 15_000);

  it("rejects transferring a wallet to itself", async () => {
    const a = await fundedUserWallet(prisma, 1_000n);
    await expect(
      wallets.transfer({
        fromWalletId: a,
        toWalletId: a,
        amountMinor: 100n,
        type: "adjustment",
        idempotencyKey: `test:${randomUUID()}`,
        actor: { type: "system" },
      }),
    ).rejects.toThrow();
  });
});
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
