import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../users/schema";
import { ledgerTransactions } from "../wallet/schema";

export const paymentIntentStatusEnum = pgEnum("payment_intent_status", [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "ABANDONED",
]);

export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "PROCESSING",
  "PAID",
  "FAILED",
]);

export const kycProviderEnum = pgEnum("kyc_provider", ["DOJAH", "PAYSTACK", "MANUAL"]);

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
    provider: text("provider").notNull(),
    /** The idempotency anchor for duplicate webhooks. */
    providerRef: text("provider_ref").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    status: paymentIntentStatusEnum("status").default("PENDING").notNull(),
    creditedTxnId: uuid("credited_txn_id").references(() => ledgerTransactions.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    rawPayload: jsonb("raw_payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payment_intents_provider_ref_unique").on(table.provider, table.providerRef),
    index("payment_intents_user_idx").on(table.userId, table.createdAt.desc()),
    check("payment_intents_amount_positive", sql`${table.amountMinor} > 0`),
  ],
);

export const virtualAccounts = pgTable(
  "virtual_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    accountNumber: text("account_number").notNull(),
    accountName: text("account_name").notNull(),
    bankName: text("bank_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("virtual_accounts_user_provider_unique").on(table.userId, table.provider),
    uniqueIndex("virtual_accounts_provider_ref_unique").on(table.provider, table.providerRef),
  ],
);

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    bankCode: text("bank_code").notNull(),
    accountNumber: text("account_number").notNull(),
    accountName: text("account_name").notNull(),
    status: withdrawalStatusEnum("status").default("REQUESTED").notNull(),
    /** Funds are held at request time; see the migration for why. */
    debitTxnId: uuid("debit_txn_id")
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: "restrict", onUpdate: "restrict" }),
    refundTxnId: uuid("refund_txn_id").references(() => ledgerTransactions.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    provider: text("provider"),
    providerRef: text("provider_ref"),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    approvalReason: text("approval_reason"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("withdrawals_debit_txn_unique").on(table.debitTxnId),
    index("withdrawals_user_idx").on(table.userId, table.createdAt.desc()),
    check("withdrawals_amount_positive", sql`${table.amountMinor} > 0`),
  ],
);

export const kycRecords = pgTable(
  "kyc_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
    level: integer("level").notNull(),
    /** HMAC-SHA256 digests only — never a raw identity number. */
    bvnHash: text("bvn_hash"),
    ninHash: text("nin_hash"),
    documentKey: text("document_key"),
    provider: kycProviderEnum("provider").notNull(),
    providerRef: text("provider_ref"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, precision: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("kyc_records_user_idx").on(table.userId, table.createdAt.desc()),
    check("kyc_records_level_range", sql`${table.level} BETWEEN 0 AND 3`),
  ],
);

export const selfExclusions = pgTable(
  "self_exclusions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Keyed on identity, not user id — it must survive re-registration. */
    identityHash: text("identity_hash").notNull(),
    until: timestamp("until", { withTimezone: true, precision: 6 }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("self_exclusions_identity_idx").on(table.identityHash)],
);

export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type VirtualAccount = typeof virtualAccounts.$inferSelect;
export type KycRecord = typeof kycRecords.$inferSelect;
export type SelfExclusion = typeof selfExclusions.$inferSelect;
