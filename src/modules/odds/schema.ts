import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const eventStatusEnum = pgEnum("event_status", [
  "PENDING",
  "LIVE",
  "SETTLED",
  "CANCELLED",
]);

// Shared by markets and selections: "settled"/"void" mean the same thing at
// either level, so two near-identical enums would only invite drift.
export const marketStatusEnum = pgEnum("market_status", [
  "OPEN",
  "SUSPENDED",
  "SETTLED",
  "VOID",
]);

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    sport: text("sport").notNull(),
    league: text("league").notNull(),
    home: text("home").notNull(),
    away: text("away").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true, precision: 6 }).notNull(),
    status: eventStatusEnum("status").default("PENDING").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("events_provider_event_unique").on(table.provider, table.providerEventId),
    index("events_status_starts_at_idx").on(table.status, table.startsAt),
  ],
);

export const markets = pgTable(
  "markets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict", onUpdate: "restrict" }),
    // Mirrors the MarketKey union in ./provider.ts. TEXT + CHECK rather than a
    // pgEnum so adding a market type is a plain constraint widening instead of
    // an enum ALTER — keep the two lists in sync.
    key: text("key").notNull(),
    status: marketStatusEnum("status").default("OPEN").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("markets_event_key_unique").on(table.eventId, table.key),
    check(
      "markets_key_supported",
      sql`${table.key} IN ('1x2', 'double_chance', 'over_under', 'btts', 'handicap', 'correct_score', 'ht_ft')`,
    ),
  ],
);

export const selections = pgTable(
  "selections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "restrict", onUpdate: "restrict" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    // Nullable: only over/under and handicap carry a line. It lives here rather
    // than on markets because one "over_under" market bundles every line the
    // provider returns (over_1.5, under_1.5, over_2.5, ...) as sibling
    // selections.
    line: numeric("line", { precision: 6, scale: 2 }),
    // NUMERIC, never float: a price is compared and stored exactly, and Phase 3
    // locks it onto the bet row.
    currentPriceDecimal: numeric("current_price_decimal", {
      precision: 7,
      scale: 3,
    }).notNull(),
    status: marketStatusEnum("status").default("OPEN").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("selections_market_key_unique").on(table.marketId, table.key),
    check("selections_price_gt_one", sql`${table.currentPriceDecimal} > 1`),
  ],
);

// Append-only raw history across ALL bookmakers, independent of whichever one
// we later treat as canonical. Needed for odds-movement charts and to evidence
// what a user was shown at placement time.
export const oddsSnapshots = pgTable(
  "odds_snapshots",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, precision: 6 }).notNull(),
  },
  (table) => [
    index("odds_snapshots_event_fetched_idx").on(
      table.provider,
      table.providerEventId,
      table.fetchedAt.desc(),
    ),
  ],
);

// NOTE: the upstream call budget lives in Redis (see ./budget.ts), not here.
// It needs a check-and-claim that cannot interleave across serverless
// instances, which Redis does with an atomic Lua script.

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
export type Selection = typeof selections.$inferSelect;
export type NewSelection = typeof selections.$inferInsert;
export type OddsSnapshotRow = typeof oddsSnapshots.$inferSelect;
