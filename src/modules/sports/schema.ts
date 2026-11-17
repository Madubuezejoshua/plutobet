import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The sports hierarchy: Sport → Competition → Event, with Teams alongside.
 *
 * See drizzle/0013_phase6_sports_taxonomy.sql for why the free-text columns on
 * `events` survive rather than being replaced — in short, they record what the
 * provider said, while these tables record what we resolved it to.
 */

export const sports = pgTable(
  "sports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** A sport is offered only once its markets are priceable and settleable. */
    active: boolean("active").notNull().default(false),
    displayOrder: integer("display_order").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sports_key_unique").on(table.key),
    check("sports_key_format", sql`${table.key} ~ '^[a-z0-9-]{2,40}$'`),
  ],
);

export const competitions = pgTable(
  "competitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sportId: uuid("sport_id")
      .notNull()
      .references(() => sports.id, { onDelete: "restrict", onUpdate: "restrict" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Free text, not an ISO code — international competitions have none. */
    country: text("country"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("competitions_sport_key_unique").on(table.sportId, table.key),
    index("competitions_country_idx").on(table.sportId, table.country),
    check("competitions_key_format", sql`${table.key} ~ '^[a-z0-9-]{1,120}$'`),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sportId: uuid("sport_id")
      .notNull()
      .references(() => sports.id, { onDelete: "restrict", onUpdate: "restrict" }),
    /** Conservative match key; see canonical-name.ts. */
    key: text("key").notNull(),
    /** Display form: accents and club designators intact. */
    name: text("name").notNull(),
    country: text("country"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("teams_sport_key_unique").on(table.sportId, table.key),
    check("teams_key_format", sql`${table.key} ~ '^[a-z0-9-]{1,120}$'`),
  ],
);

/** Spellings conservative normalisation cannot reconcile — "Spurs", "Man Utd". */
export const teamAliases = pgTable(
  "team_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict", onUpdate: "restrict" }),
    sportId: uuid("sport_id")
      .notNull()
      .references(() => sports.id, { onDelete: "restrict", onUpdate: "restrict" }),
    aliasKey: text("alias_key").notNull(),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("team_aliases_sport_alias_unique").on(table.sportId, table.aliasKey),
    index("team_aliases_team_idx").on(table.teamId),
    check("team_aliases_key_format", sql`${table.aliasKey} ~ '^[a-z0-9-]{1,120}$'`),
  ],
);

export type Sport = typeof sports.$inferSelect;
export type Competition = typeof competitions.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type TeamAlias = typeof teamAliases.$inferSelect;
