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
import { users } from "../users/schema";
import { ledgerTransactions } from "../wallet/schema";

export const gameRoundStatusEnum = pgEnum("game_round_status", [
  "OPEN",
  "SETTLED",
  "ROLLED_BACK",
]);

export const casinoSessions = pgTable(
  "casino_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
    provider: text("provider").notNull(),
    /** Digest only — a leaked row must not be replayable as a live session. */
    tokenHash: text("token_hash").notNull(),
    game: text("game"),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("casino_sessions_token_unique").on(table.tokenHash),
    index("casino_sessions_user_idx").on(table.userId, table.createdAt.desc()),
    check("casino_sessions_token_is_digest", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const gameRounds = pgTable(
  "game_rounds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
    provider: text("provider").notNull(),
    providerRoundRef: text("provider_round_ref").notNull(),
    game: text("game").notNull(),
    stakeMinor: bigint("stake_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    payoutMinor: bigint("payout_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    status: gameRoundStatusEnum("status").default("OPEN").notNull(),
    debitTxnId: uuid("debit_txn_id").references(() => ledgerTransactions.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    creditTxnId: uuid("credit_txn_id").references(() => ledgerTransactions.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    rollbackTxnId: uuid("rollback_txn_id").references(() => ledgerTransactions.id, {
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
    uniqueIndex("game_rounds_provider_ref_unique").on(table.provider, table.providerRoundRef),
    index("game_rounds_user_idx").on(table.userId, table.createdAt.desc()),
    check("game_rounds_stake_nonnegative", sql`${table.stakeMinor} >= 0`),
    check("game_rounds_payout_nonnegative", sql`${table.payoutMinor} >= 0`),
  ],
);

export type CasinoSession = typeof casinoSessions.$inferSelect;
export type GameRound = typeof gameRounds.$inferSelect;
