import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users/schema";

export const rgLimitTypeEnum = pgEnum("rg_limit_type", ["DEPOSIT", "LOSS", "WAGER", "SESSION"]);

/**
 * Append-only limit history. The limit in force is the newest row whose
 * effectiveFrom has passed; a scheduled increase sits in the future until its
 * cooling-off period elapses.
 */
export const rgLimits = pgTable(
  "rg_limits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
    type: rgLimitTypeEnum("type").notNull(),
    periodDays: integer("period_days").notNull(),
    /** Kobo for DEPOSIT/LOSS/WAGER; minutes for SESSION. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("rg_limits_active_idx").on(table.userId, table.type, table.effectiveFrom.desc()),
    check("rg_limits_amount_nonnegative", sql`${table.amountMinor} >= 0`),
    check("rg_limits_period_positive", sql`${table.periodDays} > 0`),
  ],
);

export type RgLimit = typeof rgLimits.$inferSelect;
export type RgLimitType = (typeof rgLimitTypeEnum.enumValues)[number];
