import { sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../auth/password";
import { normalizePhone } from "../notifications/phone";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import type { OddsFormat, UserRiskStatus, UserStatus } from "./schema";

/**
 * Profile, credentials and preferences.
 *
 * The rule that shapes this whole module: **changing something sensitive
 * requires proving you are still the account holder.** A stolen, still-valid
 * session must not be enough to change the password, the email address or the
 * phone number — those three are exactly how an attacker converts temporary
 * access into permanent control.
 *
 * "Sensitive" here means: password, email, phone. Display name and odds format
 * are not, and demanding a password for them only trains people to type it.
 */

export class ProfileError extends Error {
  constructor(
    readonly code:
      | "WRONG_PASSWORD"
      | "EMAIL_TAKEN"
      | "PHONE_TAKEN"
      | "USERNAME_TAKEN"
      | "WEAK_PASSWORD"
      | "SAME_PASSWORD"
      | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

export interface ProfileView {
  id: string;
  email: string;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  dateOfBirth: string | null;
  country: string;
  status: UserStatus;
  riskStatus: UserRiskStatus;
  kycLevel: number;
  referralCode: string | null;
  createdAt: Date;
}

export type OddsChangePolicy = "ASK" | "HIGHER_ONLY" | "ANY";

export interface PreferencesView {
  oddsFormat: OddsFormat;
  /** What to do when a price moves between building a slip and confirming. */
  oddsChangePolicy: OddsChangePolicy;
  emailNotifications: boolean;
  smsNotifications: boolean;
  pushNotifications: boolean;
  marketingEmails: boolean;
  timezone: string;
}

export class ProfileService {
  constructor(private readonly wallet: WalletService = walletService) {}

  async get(userId: string): Promise<ProfileView> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{
        id: string;
        email: string;
        email_verified_at: Date | null;
        phone_number: string | null;
        phone_verified_at: Date | null;
        first_name: string | null;
        last_name: string | null;
        username: string | null;
        date_of_birth: string | null;
        country: string;
        status: UserStatus;
        risk_status: UserRiskStatus;
        kyc_level: number;
        referral_code: string | null;
        created_at: Date;
      }>(sql`
        SELECT id, email, email_verified_at, phone_number, phone_verified_at,
               first_name, last_name, username, date_of_birth::text AS date_of_birth,
               country, status::text AS status, risk_status::text AS risk_status,
               kyc_level, referral_code, created_at
        FROM users WHERE id = ${userId}::uuid
      `);
      if (!row) throw new ProfileError("NOT_FOUND", "no such account");

      return {
        id: row.id,
        email: row.email,
        emailVerified: row.email_verified_at !== null,
        phoneNumber: row.phone_number,
        phoneVerified: row.phone_verified_at !== null,
        firstName: row.first_name,
        lastName: row.last_name,
        username: row.username,
        dateOfBirth: row.date_of_birth,
        country: row.country,
        status: row.status,
        riskStatus: row.risk_status,
        kycLevel: Number(row.kyc_level),
        referralCode: row.referral_code,
        createdAt: new Date(row.created_at),
      };
    });
  }

  /**
   * Updates the non-sensitive parts of a profile.
   *
   * Date of birth is deliberately NOT updatable here. It is an eligibility
   * fact, not a preference — once an account has been allowed to bet on the
   * strength of it, letting the holder edit it would make the age gate
   * decorative. Correcting a genuine mistake is a support action with its own
   * audit trail.
   */
  async updateProfile(params: {
    userId: string;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
  }): Promise<void> {
    const username =
      params.username === undefined ? undefined : params.username?.trim().toLowerCase() || null;

    if (username && !/^[a-z0-9_]{3,20}$/.test(username)) {
      throw new RangeError("username must be 3-20 characters of a-z, 0-9 or underscore");
    }

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      if (username) {
        const [taken] = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM users
          WHERE username = ${username} AND id <> ${params.userId}::uuid
        `);
        if (Number(taken?.n ?? 0) > 0) {
          throw new ProfileError("USERNAME_TAKEN", "that username is taken");
        }
      }

      await tx.execute(sql`
        UPDATE users SET
          first_name = COALESCE(${params.firstName ?? null}, first_name),
          last_name  = COALESCE(${params.lastName ?? null}, last_name),
          username   = ${username === undefined ? sql`username` : sql`${username}`},
          updated_at = now()
        WHERE id = ${params.userId}::uuid
      `);
    });
  }

  /**
   * Changes the password.
   *
   * Requires the current one. Every live session is then revoked EXCEPT the
   * one making the change: if a password change was the victim locking an
   * attacker out, leaving the attacker's session alive would defeat the whole
   * point. If it was the attacker, the victim is at least signed out and will
   * notice.
   */
  async changePassword(params: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    /** Session to preserve — the one performing the change. */
    keepSessionId?: string;
  }): Promise<void> {
    if (
      params.newPassword.length < MIN_PASSWORD_LENGTH ||
      params.newPassword.length > MAX_PASSWORD_LENGTH
    ) {
      throw new ProfileError(
        "WEAK_PASSWORD",
        `password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
      );
    }
    if (params.newPassword === params.currentPassword) {
      throw new ProfileError("SAME_PASSWORD", "the new password must be different");
    }

    const currentHash = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ password_hash: string }>(sql`
        SELECT password_hash FROM users WHERE id = ${params.userId}::uuid
      `);
      if (!row) throw new ProfileError("NOT_FOUND", "no such account");
      return row.password_hash;
    });

    // Verified and hashed OUTSIDE a transaction: argon2id is deliberately slow
    // and would otherwise pin a connection for the duration, twice over.
    if (!(await verifyPassword(currentHash, params.currentPassword))) {
      throw new ProfileError("WRONG_PASSWORD", "that is not your current password");
    }
    const newHash = await hashPassword(params.newPassword);

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE users
        SET password_hash = ${newHash}, must_change_password = false, updated_at = now()
        WHERE id = ${params.userId}::uuid
      `);

      await tx.execute(sql`
        UPDATE user_sessions
        SET revoked_at = now(), revoked_reason = 'password changed'
        WHERE user_id = ${params.userId}::uuid
          AND revoked_at IS NULL
          AND (${params.keepSessionId ?? null}::uuid IS NULL OR id <> ${params.keepSessionId ?? null}::uuid)
      `);
    });
  }

  /**
   * Changes the email address.
   *
   * Requires the password, and resets verification: the new address has not
   * been proven to belong to anyone until a code sent to it comes back.
   */
  async changeEmail(params: {
    userId: string;
    password: string;
    newEmail: string;
  }): Promise<{ email: string }> {
    const email = params.newEmail.trim().toLowerCase();

    const currentHash = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ password_hash: string }>(sql`
        SELECT password_hash FROM users WHERE id = ${params.userId}::uuid
      `);
      if (!row) throw new ProfileError("NOT_FOUND", "no such account");
      return row.password_hash;
    });

    if (!(await verifyPassword(currentHash, params.password))) {
      throw new ProfileError("WRONG_PASSWORD", "that password is not correct");
    }

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [taken] = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM users
        WHERE email = ${email} AND id <> ${params.userId}::uuid
      `);
      if (Number(taken?.n ?? 0) > 0) {
        throw new ProfileError("EMAIL_TAKEN", "an account with this email already exists");
      }

      await tx.execute(sql`
        UPDATE users
        SET email = ${email}, email_verified_at = NULL, updated_at = now()
        WHERE id = ${params.userId}::uuid
      `);
    });

    return { email };
  }

  /** Marks an address proven. Called only after an OTP to it has been consumed. */
  async markEmailVerified(userId: string): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE users SET email_verified_at = now(), updated_at = now()
        WHERE id = ${userId}::uuid AND email_verified_at IS NULL
      `);
    });
  }

  /** As above, for the phone number. */
  async markPhoneVerified(userId: string, phoneNumber: string): Promise<void> {
    const normalized = normalizePhone(phoneNumber);
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [taken] = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM users
        WHERE phone_number = ${normalized} AND id <> ${userId}::uuid
      `);
      if (Number(taken?.n ?? 0) > 0) {
        throw new ProfileError("PHONE_TAKEN", "an account with this phone number already exists");
      }

      await tx.execute(sql`
        UPDATE users
        SET phone_number = ${normalized}, phone_verified_at = now(), updated_at = now()
        WHERE id = ${userId}::uuid
      `);
    });
  }

  // ------------------------------------------------------------------
  // preferences
  // ------------------------------------------------------------------

  async preferences(userId: string): Promise<PreferencesView> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      // Upsert-on-read: accounts created before this table existed have no
      // row, and the caller should not have to care.
      await tx.execute(sql`
        INSERT INTO user_preferences (user_id) VALUES (${userId}::uuid)
        ON CONFLICT (user_id) DO NOTHING
      `);

      const [row] = await tx.execute<{
        odds_format: OddsFormat;
        odds_change_policy: OddsChangePolicy;
        email_notifications: boolean;
        sms_notifications: boolean;
        push_notifications: boolean;
        marketing_emails: boolean;
        timezone: string;
      }>(sql`
        SELECT odds_format::text AS odds_format,
               odds_change_policy::text AS odds_change_policy,
               email_notifications, sms_notifications,
               push_notifications, marketing_emails, timezone
        FROM user_preferences WHERE user_id = ${userId}::uuid
      `);
      if (!row) throw new ProfileError("NOT_FOUND", "no preferences row");

      return {
        oddsFormat: row.odds_format,
        oddsChangePolicy: row.odds_change_policy,
        emailNotifications: row.email_notifications,
        smsNotifications: row.sms_notifications,
        pushNotifications: row.push_notifications,
        marketingEmails: row.marketing_emails,
        timezone: row.timezone,
      };
    });
  }

  async updatePreferences(
    userId: string,
    patch: Partial<PreferencesView>,
  ): Promise<PreferencesView> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO user_preferences (user_id) VALUES (${userId}::uuid)
        ON CONFLICT (user_id) DO NOTHING
      `);

      await tx.execute(sql`
        UPDATE user_preferences SET
          odds_format         = COALESCE(${patch.oddsFormat ?? null}::odds_format, odds_format),
          odds_change_policy  = COALESCE(${patch.oddsChangePolicy ?? null}::odds_change_policy, odds_change_policy),
          email_notifications = COALESCE(${patch.emailNotifications ?? null}, email_notifications),
          sms_notifications   = COALESCE(${patch.smsNotifications ?? null}, sms_notifications),
          push_notifications  = COALESCE(${patch.pushNotifications ?? null}, push_notifications),
          marketing_emails    = COALESCE(${patch.marketingEmails ?? null}, marketing_emails),
          timezone            = COALESCE(${patch.timezone ?? null}, timezone),
          updated_at          = now()
        WHERE user_id = ${userId}::uuid
      `);
    });

    return this.preferences(userId);
  }
}

export const profileService = new ProfileService();

/** Re-exported so callers do not need the transaction type to write a helper. */
export type { WalletTransaction };
