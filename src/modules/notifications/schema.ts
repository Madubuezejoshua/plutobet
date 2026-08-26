import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users/schema";

export const otpChannelEnum = pgEnum("otp_channel", ["SMS", "EMAIL"]);
export const otpPurposeEnum = pgEnum("otp_purpose", [
  "PHONE_VERIFY",
  "EMAIL_VERIFY",
  "LOGIN",
  "WITHDRAWAL_CONFIRM",
  "PASSWORD_RESET",
]);
export const deliveryStatusEnum = pgEnum("delivery_status", ["SENT", "FAILED"]);

/**
 * One-time codes. The code is stored only as an HMAC digest — see
 * otp.service.ts for why the surrounding controls, not the code, are what
 * make this safe.
 */
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** E.164 phone or lower-cased email — never a user id. */
    destination: text("destination").notNull(),
    channel: otpChannelEnum("channel").notNull(),
    purpose: otpPurposeEnum("purpose").notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 6 }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, precision: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("otp_codes_lookup_idx").on(table.destination, table.purpose, table.createdAt.desc()),
    check("otp_codes_hash_is_digest", sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "otp_codes_attempts_bounded",
      sql`${table.attempts} >= 0 AND ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check("otp_codes_max_attempts_positive", sql`${table.maxAttempts} > 0`),
  ],
);

/** Append-only record of every message sent. Never stores the body. */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channel: otpChannelEnum("channel").notNull(),
    destination: text("destination").notNull(),
    template: text("template").notNull(),
    status: deliveryStatusEnum("status").notNull(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),
    error: text("error"),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("notification_deliveries_destination_idx").on(table.destination, table.createdAt.desc()),
    index("notification_deliveries_user_idx").on(table.userId, table.createdAt.desc()),
  ],
);

export type OtpCode = typeof otpCodes.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
