import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import {
  closeWalletTestContexts,
  corruptWalletCacheAsOwnerForTest,
  createLedgerFundedWallet,
  createWalletTestContext,
  testKey,
  walletSnapshot,
  type WalletTestContext,
} from "./helpers";

describe("wallet reconciliation acceptance", () => {
  let context: WalletTestContext;

  beforeAll(() => {
    context = createWalletTestContext();
  });

  afterAll(async () => {
    await closeWalletTestContexts([context]);
  });

  it("replays a clean wallet and persists a clean check", async () => {
    const walletId = await createLedgerFundedWallet(context, 5_000n);
    await context.wallet.debit({
      walletId,
      amountMinor: 1_500n,
      type: "STAKE",
      idempotencyKey: testKey("reconciliation-debit"),
      actor: { type: "SYSTEM" },
    });
    await context.wallet.credit({
      walletId,
      amountMinor: 800n,
      type: "PAYOUT",
      idempotencyKey: testKey("reconciliation-credit"),
      actor: { type: "SYSTEM" },
    });

    const result = await context.reconciliation.reconcileWallet(walletId);
    expect(result).toEqual({
      walletId,
      cachedMinor: 4_300n,
      computedMinor: 4_300n,
      driftMinor: 0n,
      status: "CLEAN",
      issues: [],
    });

    const persisted = await walletSnapshot(context, walletId);
    expect(persisted.version).toBe(3n);
    expect(persisted.reconciliationStatus).toBe("CLEAN");
    expect(persisted.reconciliationDriftMinor).toBe(0n);
    expect(persisted.reconciliationCheckedAt).toBeInstanceOf(Date);
    expect(persisted.reconciliationFlaggedAt).toBeNull();
  });

  it("flags cached-balance drift and appends immutable audit evidence", async () => {
    const walletId = await createLedgerFundedWallet(context, 5_000n);

    await corruptWalletCacheAsOwnerForTest(walletId, 999_999n);

    const result = await context.reconciliation.reconcileWallet(walletId);
    expect(result.status).toBe("FLAGGED");
    expect(result.cachedMinor).toBe(999_999n);
    expect(result.computedMinor).toBe(5_000n);
    expect(result.driftMinor).toBe(5_000n - 999_999n);
    expect(result.issues).toContain(
      "cached balance 999999 differs from reconstructed balance 5000",
    );

    const persisted = await walletSnapshot(context, walletId);
    expect(persisted.version).toBe(2n);
    expect(persisted.reconciliationStatus).toBe("FLAGGED");
    expect(persisted.reconciliationDriftMinor).toBe(5_000n - 999_999n);
    expect(persisted.reconciliationCheckedAt).toBeInstanceOf(Date);
    expect(persisted.reconciliationFlaggedAt).toBeInstanceOf(Date);

    const audits = await context.database.transaction(
      async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
        return tx
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.entityId, walletId),
              eq(auditLog.action, "WALLET_RECONCILIATION_FLAGGED"),
            ),
          );
      },
      { isolationLevel: "read committed", accessMode: "read only" },
    );
    expect(audits).toHaveLength(1);
  });
});
