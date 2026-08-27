import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actorTypeEnum } from "../audit/schema";
import { users } from "../users/schema";

export const walletCurrencyEnum = pgEnum("wallet_currency", ["NGN"]);
export const walletKindEnum = pgEnum("wallet_kind", ["USER", "SYSTEM"]);

/**
 * Balance segregation.
 *
 * A bucket is a WALLET ROW, not a column, so every ledger invariant applies to
 * it unchanged — see drizzle/0012_phase4_wallet_buckets.sql for why a second
 * balance column would have been silently unprotected.
 *
 *   CASH   — the customer's own money. The only bucket that may be withdrawn,
 *            enforced by a database trigger, not by convention.
 *   BONUS  — promotional credit with wagering conditions still attached. Not
 *            the customer's money until those are met.
 *   LOCKED — funds held: a withdrawal under review, or a disputed amount.
 *            Visible to the customer so their balance never appears to have
 *            silently shrunk.
 */
export const WALLET_BUCKETS = ["CASH", "BONUS", "LOCKED"] as const;
export type WalletBucket = (typeof WALLET_BUCKETS)[number];
export const walletBucketEnum = pgEnum("wallet_bucket", WALLET_BUCKETS);
export const systemAccountEnum = pgEnum("system_account", [
  "CASH_IN",
  "CASH_OUT",
  "STAKES_LIABILITY",
  "PAYOUTS_PAYABLE",
  "BONUS_LIABILITY",
  "ADJUSTMENTS_EQUITY",
]);
export const reconciliationStatusEnum = pgEnum("reconciliation_status", [
  "CLEAN",
  "FLAGGED",
]);
export const ledgerDirectionEnum = pgEnum("ledger_direction", ["DEBIT", "CREDIT"]);
export const ledgerTransactionTypeEnum = pgEnum("ledger_transaction_type", [
  "DEPOSIT",
  "WITHDRAWAL",
  "STAKE",
  "PAYOUT",
  "REFUND",
  "BONUS",
  "ADJUSTMENT",
  "TRANSFER",
]);

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: walletKindEnum("kind").default("USER").notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    systemAccount: systemAccountEnum("system_account"),
    currency: walletCurrencyEnum("currency").default("NGN").notNull(),
    /** USER wallets only; NULL on SYSTEM contra accounts. */
    bucket: walletBucketEnum("bucket"),

    // Only user wallets have a cached spendable balance. System wallets are
    // contra accounts and are always reconstructed from their ledger legs.
    cachedBalanceMinor: bigint("cached_balance_minor", { mode: "bigint" }).default(sql`0`),
    version: bigint("version", { mode: "bigint" }).default(sql`0`).notNull(),

    reconciliationStatus: reconciliationStatusEnum("reconciliation_status")
      .default("CLEAN")
      .notNull(),
    reconciliationDriftMinor: bigint("reconciliation_drift_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    reconciliationCheckedAt: timestamp("reconciliation_checked_at", {
      withTimezone: true,
      precision: 6,
    }),
    reconciliationFlaggedAt: timestamp("reconciliation_flagged_at", {
      withTimezone: true,
      precision: 6,
    }),

    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("wallets_user_currency_bucket_unique")
      .on(table.userId, table.currency, table.bucket)
      .where(sql`${table.kind} = 'USER'`),
    uniqueIndex("wallets_system_currency_unique")
      .on(table.systemAccount, table.currency)
      .where(sql`${table.kind} = 'SYSTEM'`),
    check(
      "wallets_kind_fields_consistent",
      sql`(
        ${table.kind} = 'USER'
        AND ${table.userId} IS NOT NULL
        AND ${table.systemAccount} IS NULL
        AND ${table.cachedBalanceMinor} IS NOT NULL
      ) OR (
        ${table.kind} = 'SYSTEM'
        AND ${table.userId} IS NULL
        AND ${table.systemAccount} IS NOT NULL
        AND ${table.cachedBalanceMinor} IS NULL
      )`,
    ),
    check(
      "wallets_bucket_matches_kind",
      sql`(${table.kind} = 'USER' AND ${table.bucket} IS NOT NULL)
          OR (${table.kind} = 'SYSTEM' AND ${table.bucket} IS NULL)`,
    ),
    check(
      "wallets_cached_balance_nonnegative",
      sql`${table.cachedBalanceMinor} IS NULL OR ${table.cachedBalanceMinor} >= 0`,
    ),
    check("wallets_version_nonnegative", sql`${table.version} >= 0`),
  ],
);

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: ledgerTransactionTypeEnum("type").notNull(),
    reference: text("reference"),
    idempotencyKey: text("idempotency_key").notNull(),

    // A SHA-256 digest of the canonical operation shape. It distinguishes a
    // legitimate replay from a caller accidentally reusing a key for a
    // different wallet, amount, direction, type, or counterparty.
    requestFingerprint: text("request_fingerprint").notNull(),

    // Prevents appending new legs to an already-committed header. The raw
    // migration fills this from pg_current_xact_id() and an entry trigger
    // requires the inserting transaction to have created the header.
    creationTransactionId: bigint("creation_transaction_id", { mode: "bigint" })
      .default(sql`(pg_current_xact_id()::text::bigint)`)
      .notNull(),

    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("ledger_transactions_idempotency_key_unique").on(table.idempotencyKey),
    uniqueIndex("ledger_transactions_reference_unique")
      .on(table.reference)
      .where(sql`${table.reference} IS NOT NULL`),
    check(
      "ledger_transactions_request_fingerprint_format",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ledger_transactions_actor_id_consistent",
      sql`(${table.actorType} = 'SYSTEM' AND ${table.actorId} IS NULL)
          OR (${table.actorType} <> 'SYSTEM' AND ${table.actorId} IS NOT NULL)`,
    ),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    txnId: uuid("txn_id")
      .notNull()
      .references(() => ledgerTransactions.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    direction: ledgerDirectionEnum("direction").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    balanceAfterMinor: bigint("balance_after_minor", { mode: "bigint" }),
    // Monotonic per user wallet. This—not timestamp/UUID order—is the replay
    // sequence when concurrent transactions began in a different order than
    // they acquired the wallet row lock.
    walletVersion: bigint("wallet_version", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("ledger_entries_wallet_statement_idx").on(
      table.walletId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("ledger_entries_txn_idx").on(table.txnId),
    uniqueIndex("ledger_entries_wallet_version_unique")
      .on(table.walletId, table.walletVersion)
      .where(sql`${table.walletVersion} IS NOT NULL`),
    check("ledger_entries_amount_positive", sql`${table.amountMinor} > 0`),
    check(
      "ledger_entries_balance_after_nonnegative",
      sql`${table.balanceAfterMinor} IS NULL OR ${table.balanceAfterMinor} >= 0`,
    ),
    check(
      "ledger_entries_wallet_state_paired",
      sql`(${table.balanceAfterMinor} IS NULL) = (${table.walletVersion} IS NULL)`,
    ),
    check(
      "ledger_entries_wallet_version_positive",
      sql`${table.walletVersion} IS NULL OR ${table.walletVersion} > 0`,
    ),
  ],
);

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;
export type NewLedgerTransaction = typeof ledgerTransactions.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
