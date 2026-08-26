import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { fundedUserWallet, makeTestContext } from "./test-helpers";
import { WalletService } from "./wallet.service";

const { prisma, wallets, reconciliation } = makeTestContext();

/**
 * fundedUserWallet() seeds cached_balance_minor directly, with no matching
 * ledger entry — a convenience for tests that only care about the starting
 * number being right for authorization checks. Reconciliation tests need
 * the opposite: the ledger *is* the source of truth being reconciled
 * against, so the starting balance has to come from a real credit() call
 * like it would for an actual user, or "drift" is just an artifact of the
 * fixture, not a real finding.
 */
async function ledgerFundedWallet(wallets: WalletService, prisma: PrismaService, amountMinor: bigint): Promise<string> {
  const walletId = await fundedUserWallet(prisma, 0n);
  await wallets.credit({
    walletId,
    amountMinor,
    counterparty: "bonus_liability",
    type: "bonus",
    idempotencyKey: `test:seed:${randomUUID()}`,
    actor: { type: "system" },
  });
  return walletId;
}

describe("WalletReconciliationService", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reports zero drift when the cached balance matches the ledger", async () => {
    const walletId = await ledgerFundedWallet(wallets, prisma, 5_000n);
    await wallets.debit({
      walletId,
      amountMinor: 1_500n,
      counterparty: "stakes_liability",
      type: "stake",
      idempotencyKey: `test:${randomUUID()}`,
      actor: { type: "system" },
    });
    await wallets.credit({
      walletId,
      amountMinor: 800n,
      counterparty: "payouts_payable",
      type: "payout",
      idempotencyKey: `test:${randomUUID()}`,
      actor: { type: "system" },
    });

    const drift = await reconciliation.reconcileWallet(walletId);
    expect(drift).not.toBeNull();
    expect(drift!.cachedMinor).toBe(4_300n); // 5000 - 1500 + 800
    expect(drift!.computedMinor).toBe(4_300n);
    expect(drift!.driftMinor).toBe(0n);
  });

  it("detects drift when cached_balance_minor diverges from the ledger", async () => {
    const walletId = await ledgerFundedWallet(wallets, prisma, 5_000n);
    await wallets.debit({
      walletId,
      amountMinor: 1_000n,
      counterparty: "stakes_liability",
      type: "stake",
      idempotencyKey: `test:${randomUUID()}`,
      actor: { type: "system" },
    });

    // Simulate corruption: something wrote cached_balance_minor outside
    // WalletService (an app bug, bad manual DB surgery). Goes around the
    // ledger entirely via raw SQL — this is the exact failure reconciliation
    // exists to catch.
    await prisma.$executeRaw`UPDATE wallets SET cached_balance_minor = 999999, version = version + 1 WHERE id = ${walletId}::uuid`;

    const drift = await reconciliation.reconcileWallet(walletId);
    expect(drift).not.toBeNull();
    expect(drift!.cachedMinor).toBe(999_999n);
    expect(drift!.computedMinor).toBe(4_000n); // 5000 - 1000, from the ledger
    expect(drift!.driftMinor).toBe(4_000n - 999_999n);
  });

  it("reconcileAll surfaces only wallets with nonzero drift", async () => {
    const clean = await ledgerFundedWallet(wallets, prisma, 2_000n);
    const corrupted = await ledgerFundedWallet(wallets, prisma, 2_000n);
    await prisma.$executeRaw`UPDATE wallets SET cached_balance_minor = 1, version = version + 1 WHERE id = ${corrupted}::uuid`;

    const drifts = await reconciliation.reconcileAll();
    const ids = drifts.map((d) => d.walletId);
    expect(ids).toContain(corrupted);
    expect(ids).not.toContain(clean);
  });
});
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
