import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const USER_ROLES = ["USER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["ACTIVE", "SUSPENDED", "SELF_EXCLUDED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const userRoleEnum = pgEnum("user_role", USER_ROLES);
export const userStatusEnum = pgEnum("user_status", USER_STATUSES);

/**
 * Legal user-status changes.
 *
 * ACTIVE        -> SUSPENDED | SELF_EXCLUDED
 * SUSPENDED     -> ACTIVE | SELF_EXCLUDED
 * SELF_EXCLUDED -> no direct transition
 *
 * Self-exclusion is deliberately terminal here. A future responsible-gaming
 * workflow may introduce an expiry/reinstatement process with its own
 * regulatory checks; ordinary user/admin status updates must never reactivate
 * a self-excluded identity.
 */
export const LEGAL_USER_STATUS_TRANSITIONS = {
  ACTIVE: ["SUSPENDED", "SELF_EXCLUDED"],
  SUSPENDED: ["ACTIVE", "SELF_EXCLUDED"],
  SELF_EXCLUDED: [],
} as const satisfies Record<UserStatus, readonly UserStatus[]>;

export function isLegalUserStatusTransition(from: UserStatus, to: UserStatus): boolean {
  return (LEGAL_USER_STATUS_TRANSITIONS[from] as readonly UserStatus[]).includes(to);
}

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    phoneNumber: text("phone_number"),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("USER"),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    kycLevel: integer("kyc_level").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("users_email_unique").on(table.email),
    check(
      "users_email_canonical",
      sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) BETWEEN 3 AND 320`,
    ),
    check("users_kyc_level_nonnegative", sql`${table.kycLevel} >= 0`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

