import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { users } from "@/modules/users/schema";
import { WalletOwnershipError } from "../errors";
import {
  closeWalletTestContexts,
  createWalletTestContext,
  createZeroBalanceWalletWithOwner,
  testKey,
} from "./helpers";

const context = createWalletTestContext();
const IP = "102.89.0.1";

afterAll(async () => {
  await closeWalletTestContexts([context]);
});

describe("user wallet ownership", () => {
  it("rejects user debit, credit, and transfer-from against another user's wallet", async () => {
    const owner = await createZeroBalanceWalletWithOwner(context);
    const other = await createZeroBalanceWalletWithOwner(context);
    await context.wallet.credit({
      walletId: owner.walletId,
      amountMinor: 10_000n,
      type: "DEPOSIT",
      idempotencyKey: testKey("ownership-fund"),
      actor: { type: "SYSTEM" },
    });

    const actor = { type: "USER" as const, id: other.userId, ip: IP };
    await expect(context.wallet.debit({
      walletId: owner.walletId,
      amountMinor: 1_000n,
      type: "STAKE",
      idempotencyKey: testKey("ownership-debit"),
      actor,
    })).rejects.toBeInstanceOf(WalletOwnershipError);
    await expect(context.wallet.credit({
      walletId: owner.walletId,
      amountMinor: 1_000n,
      type: "REFUND",
      idempotencyKey: testKey("ownership-credit"),
      actor,
    })).rejects.toBeInstanceOf(WalletOwnershipError);
    await expect(context.wallet.transfer({
      fromWalletId: owner.walletId,
      toWalletId: other.walletId,
      amountMinor: 1_000n,
      idempotencyKey: testKey("ownership-transfer"),
      actor,
    })).rejects.toBeInstanceOf(WalletOwnershipError);

    expect(await context.wallet.getBalance(owner.walletId)).toBe(10_000n);
    expect(await context.wallet.getBalance(other.walletId)).toBe(0n);
  });

  it("lets a domain write and debit roll back through the public transaction context", async () => {
    const owner = await createZeroBalanceWalletWithOwner(context);
    await context.wallet.credit({
      walletId: owner.walletId,
      amountMinor: 10_000n,
      type: "DEPOSIT",
      idempotencyKey: testKey("orchestration-fund"),
      actor: { type: "SYSTEM" },
    });
    const email = `${randomUUID()}@wallet-transaction.test`;

    await expect(context.wallet.withMoneyTransaction(async ({ tx, debit }) => {
      await debit({
        walletId: owner.walletId,
        amountMinor: 2_000n,
        type: "STAKE",
        idempotencyKey: testKey("orchestration-debit"),
        actor: { type: "USER", id: owner.userId, ip: IP },
      });
      await tx.insert(users).values({
        email,
        passwordHash: "test-only-not-an-authentication-hash",
      });
      throw new Error("force domain rollback");
    })).rejects.toThrow("force domain rollback");

    expect(await context.wallet.getBalance(owner.walletId)).toBe(10_000n);
    const domainRows = await context.database.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(domainRows).toHaveLength(0);
  });
});
