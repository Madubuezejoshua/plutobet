import { sql } from "drizzle-orm";
import { check, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { events } from "../odds/schema";
import type { PeriodScore } from "./resolve";

export const matchResultStatusEnum = pgEnum("match_result_status", ["SETTLED", "CANCELLED"]);

/**
 * Append-only ingestion history — one row per delivery, not per event. Feeds
 * resend and correct constantly; settlement reads the newest row and
 * idempotency lives on the bet's terminal status.
 */
export const eventResults = pgTable(
  "event_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict", onUpdate: "restrict" }),
    status: matchResultStatusEnum("status").notNull(),
    periods: jsonb("periods").$type<Record<string, PeriodScore>>().notNull(),
    provider: text("provider").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("event_results_event_ingested_idx").on(table.eventId, table.ingestedAt.desc()),
    check("event_results_periods_is_object", sql`jsonb_typeof(${table.periods}) = 'object'`),
  ],
);

export type EventResultRow = typeof eventResults.$inferSelect;
export type NewEventResult = typeof eventResults.$inferInsert;
