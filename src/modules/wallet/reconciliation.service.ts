import { and, asc, eq, gt, sql } from "drizzle-orm";
import { appendAuditLog } from "../audit/append";
import { dbDirect, type DirectDatabase } from "./db-direct";
import { ConcurrentWalletMutationError, NonUserWalletError, WalletNotFoundError } from "./errors";
import { ledgerEntries, wallets } from "./schema";
import type { WalletDrift } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeWalletId(walletId: string): string {
  if (!UUID_PATTERN.test(walletId)) throw new TypeError(`invalid wallet UUID: ${walletId}`);
  return walletId.toLowerCase();
}

export class WalletReconciliationService {
  constructor(private readonly database: DirectDatabase = dbDirect) {}

  async listWalletIds(afterId?: string, limit = 500): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("reconciliation page limit must be an integer between 1 and 500");
    }
    afterId = afterId ? normalizeWalletId(afterId) : undefined;
    return this.database.transaction(
      async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
        const rows = await tx.select({ id: wallets.id }).from(wallets)
          .where(and(eq(wallets.kind, "USER"), afterId ? gt(wallets.id, afterId) : undefined))
          .orderBy(asc(wallets.id)).limit(limit);
        return rows.map((row) => row.id);
      },
      { isolationLevel: "read committed", accessMode: "read only" },
    );
  }

  async reconcileWallet(walletId: string): Promise<WalletDrift> {
    walletId = normalizeWalletId(walletId);
    return this.database.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      const [before] = await tx.select({
        kind: wallets.kind,
        cachedMinor: wallets.cachedBalanceMinor,
        version: wallets.version,
        previousStatus: wallets.reconciliationStatus,
        previousDrift: wallets.reconciliationDriftMinor,
        previousFlaggedAt: wallets.reconciliationFlaggedAt,
      }).from(wallets).where(eq(wallets.id, walletId)).limit(1);
      if (!before) throw new WalletNotFoundError(walletId);
      if (before.kind !== "USER" || before.cachedMinor === null) throw new NonUserWalletError(walletId);

      const entries = await tx.select({
        id: ledgerEntries.id,
        direction: ledgerEntries.direction,
        amountMinor: ledgerEntries.amountMinor,
        balanceAfterMinor: ledgerEntries.balanceAfterMinor,
        walletVersion: ledgerEntries.walletVersion,
      }).from(ledgerEntries).where(eq(ledgerEntries.walletId, walletId))
        .orderBy(asc(ledgerEntries.walletVersion));

      let computedMinor = 0n;
      const issues: string[] = [];
      let expectedWalletVersion = 1n;
      for (const entry of entries) {
        if (entry.walletVersion === null) {
          issues.push(`entry ${entry.id} has no wallet replay version`);
        } else if (entry.walletVersion !== expectedWalletVersion) {
          issues.push(
            `entry ${entry.id} has wallet version ${entry.walletVersion}, expected ${expectedWalletVersion}`,
          );
        }
        computedMinor += entry.direction === "CREDIT" ? entry.amountMinor : -entry.amountMinor;
        if (computedMinor < 0n) issues.push(`entry ${entry.id} makes the reconstructed balance negative`);
        if (entry.balanceAfterMinor !== computedMinor) {
          issues.push(`entry ${entry.id} records balanceAfter=${entry.balanceAfterMinor?.toString() ?? "null"}, expected=${computedMinor}`);
        }
        expectedWalletVersion += 1n;
      }

      if (before.version !== BigInt(entries.length)) {
        issues.push(
          `wallet version ${before.version} differs from replay entry count ${entries.length}`,
        );
      }

      const [afterReplay] = await tx.select({ version: wallets.version }).from(wallets)
        .where(eq(wallets.id, walletId)).limit(1);
      if (!afterReplay || afterReplay.version !== before.version) throw new ConcurrentWalletMutationError(walletId);

      const driftMinor = computedMinor - before.cachedMinor;
      if (driftMinor !== 0n) issues.push(`cached balance ${before.cachedMinor} differs from reconstructed balance ${computedMinor}`);
      const status = issues.length === 0 ? "CLEAN" : "FLAGGED";
      const checkedAt = new Date();

      // The version predicate closes the final race between replay and flag.
      const updated = await tx.update(wallets).set({
        reconciliationStatus: status,
        reconciliationDriftMinor: driftMinor,
        reconciliationCheckedAt: checkedAt,
        reconciliationFlaggedAt:
          status === "FLAGGED" ? (before.previousFlaggedAt ?? checkedAt) : null,
      }).where(and(eq(wallets.id, walletId), eq(wallets.version, before.version)))
        .returning({ id: wallets.id });
      if (updated.length !== 1) throw new ConcurrentWalletMutationError(walletId);

      const stateChanged = before.previousStatus !== status || before.previousDrift !== driftMinor;
      if (stateChanged) {
        await appendAuditLog(tx, {
          actorType: "SYSTEM",
          actorId: null,
          action: status === "FLAGGED" ? "WALLET_RECONCILIATION_FLAGGED" : "WALLET_RECONCILIATION_CLEARED",
          entity: "WALLET",
          entityId: walletId,
          before: { status: before.previousStatus, driftMinor: before.previousDrift.toString() },
          after: {
            status,
            cachedMinor: before.cachedMinor.toString(),
            computedMinor: computedMinor.toString(),
            driftMinor: driftMinor.toString(),
            issues,
          },
        });
      }

      return { walletId, cachedMinor: before.cachedMinor, computedMinor, driftMinor, status, issues };
    }, { isolationLevel: "read committed", accessMode: "read write" });
  }
}

export const walletReconciliationService = new WalletReconciliationService();
