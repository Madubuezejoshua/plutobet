import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Shared actor vocabulary for both the immutable audit trail and ledger
 * transaction headers. SYSTEM actors deliberately have no user id.
 */
export const actorTypeEnum = pgEnum("actor_type", ["USER", "ADMIN", "SYSTEM"]);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    /** Mandatory at the service boundary for ADMIN money actions. */
    reason: text("reason"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    ip: inet("ip"),
    // Lets deferred ledger constraints prove that audit evidence was appended
    // by the transaction that created the ledger header.
    creationTransactionId: bigint("creation_transaction_id", { mode: "bigint" })
      .default(sql`(pg_current_xact_id()::text::bigint)`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "audit_log_actor_id_consistent",
      sql`(${table.actorType} = 'SYSTEM' AND ${table.actorId} IS NULL)
          OR (${table.actorType} <> 'SYSTEM' AND ${table.actorId} IS NOT NULL)`,
    ),
    check(
      "audit_log_admin_reason_valid",
      sql`${table.actorType} <> 'ADMIN' OR (
        ${table.reason} IS NOT NULL
        AND char_length(${table.reason}) <= 500
        AND char_length(regexp_replace(${table.reason}, '(^[[:space:]]+)|([[:space:]]+$)', '', 'g')) >= 3
      )`,
    ),
    check(
      "audit_log_non_system_ip_required",
      sql`${table.actorType} = 'SYSTEM' OR ${table.ip} IS NOT NULL`,
    ),
    index("audit_log_creation_transaction_id_idx").on(table.creationTransactionId),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
