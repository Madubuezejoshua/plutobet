import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  inet,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const USER_ROLES = ["USER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "RESTRICTED",
  "VERIFICATION_REQUIRED",
  "SELF_EXCLUDED",
  "CLOSED",
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_RISK_STATUSES = ["NORMAL", "WATCH", "HIGH"] as const;
export type UserRiskStatus = (typeof USER_RISK_STATUSES)[number];

export const ODDS_FORMATS = ["DECIMAL", "FRACTIONAL", "AMERICAN"] as const;
export type OddsFormat = (typeof ODDS_FORMATS)[number];

export const userRoleEnum = pgEnum("user_role", USER_ROLES);
export const userStatusEnum = pgEnum("user_status", USER_STATUSES);
export const userRiskStatusEnum = pgEnum("user_risk_status", USER_RISK_STATUSES);
export const oddsFormatEnum = pgEnum("odds_format", ODDS_FORMATS);

/**
 * Legal user-status changes. Mirrors the database trigger in
 * drizzle/0010_phase2_accounts.sql — the trigger is authoritative, this exists
 * so the application can refuse early with a useful message rather than
 * catching a 23514.
 *
 * SELF_EXCLUDED and CLOSED are terminal. Neither may be reversed by an
 * ordinary status update: reinstatement after self-exclusion is a regulated
 * workflow with its own checks, and reopening a closed account is a new
 * registration, which is the only path that re-runs the exclusion and KYC
 * tests.
 */
export const LEGAL_USER_STATUS_TRANSITIONS = {
  ACTIVE: ["SUSPENDED", "RESTRICTED", "VERIFICATION_REQUIRED", "SELF_EXCLUDED", "CLOSED"],
  SUSPENDED: ["ACTIVE", "RESTRICTED", "SELF_EXCLUDED", "CLOSED"],
  RESTRICTED: ["ACTIVE", "SUSPENDED", "SELF_EXCLUDED", "CLOSED"],
  VERIFICATION_REQUIRED: ["ACTIVE", "SUSPENDED", "SELF_EXCLUDED", "CLOSED"],
  SELF_EXCLUDED: [],
  CLOSED: [],
} as const satisfies Record<UserStatus, readonly UserStatus[]>;

export function isLegalUserStatusTransition(from: UserStatus, to: UserStatus): boolean {
  return (LEGAL_USER_STATUS_TRANSITIONS[from] as readonly UserStatus[]).includes(to);
}

/** Statuses that may browse and bet. Everything else is read-only or worse. */
export function canPlaceBets(status: UserStatus): boolean {
  return status === "ACTIVE";
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

    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Stored lower-cased; uniqueness is therefore case-insensitive. */
    username: text("username"),
    /** Null means age has not been established. The DB trigger rejects under-18s. */
    dateOfBirth: date("date_of_birth"),
    country: text("country").notNull().default("NG"),
    riskStatus: userRiskStatusEnum("risk_status").notNull().default("NORMAL"),
    referralCode: text("referral_code"),
    referredBy: uuid("referred_by"),

    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, precision: 6 }),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true, precision: 6 }),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("users_email_unique").on(table.email),
    uniqueIndex("users_username_unique")
      .on(table.username)
      .where(sql`${table.username} IS NOT NULL`),
    uniqueIndex("users_referral_code_unique")
      .on(table.referralCode)
      .where(sql`${table.referralCode} IS NOT NULL`),
    check(
      "users_email_canonical",
      sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) BETWEEN 3 AND 320`,
    ),
    check("users_kyc_level_nonnegative", sql`${table.kycLevel} >= 0`),
    check(
      "users_username_canonical",
      sql`${table.username} IS NULL OR (${table.username} = lower(${table.username}) AND ${table.username} ~ '^[a-z0-9_]{3,20}$')`,
    ),
    check(
      "users_referral_code_format",
      sql`${table.referralCode} IS NULL OR ${table.referralCode} ~ '^[A-Z0-9]{6,12}$'`,
    ),
    check(
      "users_no_self_referral",
      sql`${table.referredBy} IS NULL OR ${table.referredBy} <> ${table.id}`,
    ),
    check(
      "users_dob_plausible",
      sql`${table.dateOfBirth} IS NULL OR (${table.dateOfBirth} > DATE '1900-01-01' AND ${table.dateOfBirth} < DATE '2100-01-01')`,
    ),
    check("users_country_format", sql`${table.country} ~ '^[A-Z]{2}$'`),
  ],
);

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
  oddsFormat: oddsFormatEnum("odds_format").notNull().default("DECIMAL"),
  emailNotifications: boolean("email_notifications").notNull().default(true),
  smsNotifications: boolean("sms_notifications").notNull().default(true),
  pushNotifications: boolean("push_notifications").notNull().default(false),
  /** Opt-IN, unlike the service notifications above. */
  marketingEmails: boolean("marketing_emails").notNull().default(false),
  timezone: text("timezone").notNull().default("Africa/Lagos"),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
});

/**
 * Revocation records for JWT sessions.
 *
 * The token itself is stateless; this row is what lets it be killed. No token
 * material is stored — only the id carried in the `sid` claim.
 */
export const userSessions = pgTable("user_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict", onUpdate: "restrict" }),
  userAgent: text("user_agent"),
  ip: inet("ip"),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, precision: 6 }),
  revokedReason: text("revoked_reason"),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserPreferences = typeof userPreferences.$inferSelect;
export type UserSession = typeof userSessions.$inferSelect;
