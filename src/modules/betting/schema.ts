import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { markets, selections } from "../odds/schema";
import { users } from "../users/schema";
import { ledgerTransactions } from "../wallet/schema";

export const betStatusEnum = pgEnum("bet_status", [
  "PENDING",
  "WON",
  "LOST",
  "VOID",
  "CASHED_OUT",
]);

export const betLegResultEnum = pgEnum("bet_leg_result", [
  "PENDING",
  "WON",
  "LOST",
  "VOID",
]);

export const bets = pgTable(
  "bets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),

    // INVARIANT 8, structural: a bet cannot exist without the ledger
    // transaction that debited its stake, and no two bets may share one.
    stakeTxnId: uuid("stake_txn_id")
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: "restrict", onUpdate: "restrict" }),

    stakeMinor: bigint("stake_minor", { mode: "bigint" }).notNull(),

    // Display only, rounded from the product of the leg odds.
    // potentialReturnMinor is authoritative and is derived from the leg odds
    // directly — see ../betting/pricing.ts for why deriving it from this
    // rounded value would round twice.
    totalOddsDecimal: numeric("total_odds_decimal", { precision: 12, scale: 3 }).notNull(),
    potentialReturnMinor: bigint("potential_return_minor", { mode: "bigint" }).notNull(),

    status: betStatusEnum("status").default("PENDING").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, precision: 6 }),

    // Cash-out: the ledger transaction that bought the bet back, and what it
    // paid. UNIQUE on the txn id so a bet can never be cashed out twice.
    cashoutTxnId: uuid("cashout_txn_id").references(() => ledgerTransactions.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    cashoutValueMinor: bigint("cashout_value_minor", { mode: "bigint" }),

    // How much of the ORIGINAL stake has been bought back, across however many
    // partial cash-outs. Settlement pays on what remains, so a bet half cashed
    // out settles for half. A full cash-out sets it to the whole stake.
    cashedOutStakeMinor: bigint("cashed_out_stake_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),

    // How much of this bet's exposure claim has already been given back.
    //
    // The claim is `potential_return_minor - stake_minor` per market. Every
    // release adds what it released, and the final one returns the remainder,
    // so the total is exactly the claim however many instalments it took.
    // Without this a partial cash-out's slice was released twice — once by the
    // cash-out and again by settlement.
    releasedLiabilityMinor: bigint("released_liability_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),
  },
  (table) => [
    uniqueIndex("bets_stake_txn_unique").on(table.stakeTxnId),
    index("bets_user_placed_idx").on(table.userId, table.placedAt.desc()),
    check("bets_stake_positive", sql`${table.stakeMinor} > 0`),
    check("bets_odds_gt_one", sql`${table.totalOddsDecimal} > 1`),
    check("bets_return_covers_stake", sql`${table.potentialReturnMinor} >= ${table.stakeMinor}`),
    check(
      "bets_settled_at_matches_status",
      sql`(${table.status} = 'PENDING' AND ${table.settledAt} IS NULL)
          OR (${table.status} <> 'PENDING' AND ${table.settledAt} IS NOT NULL)`,
    ),
  ],
);

export const betLegs = pgTable(
  "bet_legs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    betId: uuid("bet_id")
      .notNull()
      .references(() => bets.id, { onDelete: "restrict", onUpdate: "restrict" }),
    selectionId: uuid("selection_id")
      .notNull()
      .references(() => selections.id, { onDelete: "restrict", onUpdate: "restrict" }),

    // INVARIANT 7: the price the user saw, frozen. Settlement reads this,
    // never selections.currentPriceDecimal.
    lockedOddsDecimal: numeric("locked_odds_decimal", { precision: 7, scale: 3 }).notNull(),

    result: betLegResultEnum("result").default("PENDING").notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, precision: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("bet_legs_bet_selection_unique").on(table.betId, table.selectionId),
    index("bet_legs_bet_idx").on(table.betId),
    check("bet_legs_odds_gt_one", sql`${table.lockedOddsDecimal} > 1`),
    check(
      "bet_legs_settled_at_matches_result",
      sql`(${table.result} = 'PENDING' AND ${table.settledAt} IS NULL)
          OR (${table.result} <> 'PENDING' AND ${table.settledAt} IS NOT NULL)`,
    ),
  ],
);

export const exposure = pgTable(
  "exposure",
  {
    marketId: uuid("market_id")
      .primaryKey()
      .references(() => markets.id, { onDelete: "restrict", onUpdate: "restrict" }),
    totalLiabilityMinor: bigint("total_liability_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    // No default: an unbounded market is a book that cannot lose gracefully.
    ceilingMinor: bigint("ceiling_minor", { mode: "bigint" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("exposure_liability_nonnegative", sql`${table.totalLiabilityMinor} >= 0`),
    check("exposure_ceiling_positive", sql`${table.ceilingMinor} > 0`),
    check("exposure_within_ceiling", sql`${table.totalLiabilityMinor} <= ${table.ceilingMinor}`),
  ],
);

export type Bet = typeof bets.$inferSelect;
export type NewBet = typeof bets.$inferInsert;
export type BetLeg = typeof betLegs.$inferSelect;
export type NewBetLeg = typeof betLegs.$inferInsert;
export type Exposure = typeof exposure.$inferSelect;
