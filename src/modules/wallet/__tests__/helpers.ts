import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { auditLog } from "@/modules/audit/schema";
import { users } from "@/modules/users/schema";
import {
  createDirectDatabase,
  createDirectSqlClient,
  type DirectDatabase,
  type DirectSqlClient,
} from "../db-direct";
import { WalletReconciliationService } from "../reconciliation.service";
import { ledgerEntries, ledgerTransactions, wallets } from "../schema";
import { WalletService } from "../wallet.service";

export type WalletTestContext = {
  sql: DirectSqlClient;
  database: DirectDatabase;
  wallet: WalletService;
  reconciliation: WalletReconciliationService;
};

function directUrl(): string {
  const value = process.env.DIRECT_DATABASE_URL;
  if (!value) throw new Error("DIRECT_DATABASE_URL is missing from the test environment");
  return value;
}

function ownerUrl(): string {
  const value = process.env.MIGRATION_DATABASE_URL;
  if (!value) throw new Error("MIGRATION_DATABASE_URL is missing from the test environment");
  return value;
}

export function createWalletTestContext(): WalletTestContext {
  const sqlClient = createDirectSqlClient(directUrl());
  const database = createDirectDatabase(sqlClient);
  return {
    sql: sqlClient,
    database,
    wallet: new WalletService(database),
    reconciliation: new WalletReconciliationService(database),
  };
}

export function createWalletWorkerPool(size: number): WalletTestContext[] {
  return Array.from({ length: size }, () => createWalletTestContext());
}

/**
 * Creates historical corruption for reconciliation tests without weakening
 * the runtime role. Trigger disable/enable and the mutation share one owner
 * transaction, so any failure rolls the trigger-state change back too.
 */
export async function corruptWalletCacheAsOwnerForTest(
  walletId: string,
  cachedBalanceMinor: bigint,
): Promise<void> {
  const ownerSql = createDirectSqlClient(ownerUrl());
  try {
    await ownerSql.begin(async (tx) => {
      await tx`ALTER TABLE wallets DISABLE TRIGGER wallets_ledger_state_at_commit`;
      const updated = await tx<{ id: string }[]>`
        UPDATE wallets
        SET cached_balance_minor = ${cachedBalanceMinor},
            version = version + 1,
            updated_at = now()
        WHERE id = ${walletId}
        RETURNING id
      `;
      if (updated.length !== 1) throw new Error(`missing user wallet ${walletId}`);
      await tx`ALTER TABLE wallets ENABLE TRIGGER wallets_ledger_state_at_commit`;
    });
  } finally {
    await ownerSql.end({ timeout: 5 });
  }
}

export async function closeWalletTestContexts(contexts: WalletTestContext[]): Promise<void> {
  await Promise.all(contexts.map((context) => context.sql.end({ timeout: 5 })));
}

export function testKey(prefix: string): string {
  return `test:${prefix}:${randomUUID()}`;
}

export async function createZeroBalanceWalletWithOwner(
  context: WalletTestContext,
): Promise<{ userId: string; walletId: string }> {
  return context.database.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    const [user] = await tx
      .insert(users)
      .values({
        email: `${randomUUID()}@wallet.test`,
        passwordHash: "test-only-not-an-authentication-hash",
      })
      .returning({ id: users.id });
    if (!user) throw new Error("test user insert returned no id");

    const [wallet] = await tx
      .insert(wallets)
      .values({ kind: "USER", userId: user.id, currency: "NGN", cachedBalanceMinor: 0n })
      .returning({ id: wallets.id });
    if (!wallet) throw new Error("test wallet insert returned no id");
    return { userId: user.id, walletId: wallet.id };
  });
}

export async function createZeroBalanceWallet(context: WalletTestContext): Promise<string> {
  return (await createZeroBalanceWalletWithOwner(context)).walletId;
}

export async function createLedgerFundedWallet(
  context: WalletTestContext,
  balanceMinor: bigint,
): Promise<string> {
  if (balanceMinor <= 0n) throw new Error("ledger-funded test wallets require a positive amount");
  const walletId = await createZeroBalanceWallet(context);
  await context.wallet.credit({
    walletId,
    amountMinor: balanceMinor,
    type: "DEPOSIT",
    idempotencyKey: testKey("fund"),
    actor: { type: "SYSTEM" },
  });
  return walletId;
}

export async function replayWallet(
  context: WalletTestContext,
  walletId: string,
): Promise<bigint> {
  return context.database.transaction(
    async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      const entries = await tx
        .select({ direction: ledgerEntries.direction, amountMinor: ledgerEntries.amountMinor })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.walletId, walletId));
      return entries.reduce(
        (balance, entry) =>
          balance + (entry.direction === "CREDIT" ? entry.amountMinor : -entry.amountMinor),
        0n,
      );
    },
    { isolationLevel: "read committed", accessMode: "read only" },
  );
}

export async function walletSnapshot(context: WalletTestContext, walletId: string) {
  return context.database.transaction(
    async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      const [wallet] = await tx
        .select({
          cachedBalanceMinor: wallets.cachedBalanceMinor,
          version: wallets.version,
          reconciliationStatus: wallets.reconciliationStatus,
          reconciliationDriftMinor: wallets.reconciliationDriftMinor,
          reconciliationCheckedAt: wallets.reconciliationCheckedAt,
          reconciliationFlaggedAt: wallets.reconciliationFlaggedAt,
        })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);
      if (!wallet || wallet.cachedBalanceMinor === null) {
        throw new Error(`missing user wallet ${walletId}`);
      }
      return wallet;
    },
    { isolationLevel: "read committed", accessMode: "read only" },
  );
}

export async function operationEvidence(context: WalletTestContext, idempotencyKey: string) {
  return context.database.transaction(
    async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      const transactions = await tx
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey));
      if (transactions.length === 0) {
        return { transactions: 0, transactionId: null, legs: 0, audits: 0 };
      }

      const transactionId = transactions[0]!.id;
      const legs = await tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.txnId, transactionId));
      const audits = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(sql`${auditLog.after} ->> 'transactionId' = ${transactionId}`);

      return {
        transactions: transactions.length,
        transactionId,
        legs: legs.length,
        audits: audits.length,
      };
    },
    { isolationLevel: "read committed", accessMode: "read only" },
  );
}
