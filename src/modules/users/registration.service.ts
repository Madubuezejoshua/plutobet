import { sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { hashBvn, hashNin } from "../kyc/identity";
import { normalizePhone } from "../notifications/phone";
import { walletService, WalletService } from "../wallet/wallet.service";
import { bucketService } from "../wallet/buckets.service";
import type { WalletTransaction } from "../wallet/types";
import { assertOldEnough } from "./age";
import { generateReferralCode, isValidReferralCode, normalizeReferralCode } from "./referral-code";

/**
 * Account registration.
 *
 * The user row and their NGN wallet are created in ONE transaction. Splitting
 * them leaves accounts that exist but cannot hold money, and the repair path
 * for that runs through the ledger — far more expensive than getting it right
 * once here.
 */

export class RegistrationError extends Error {
  constructor(
    readonly code:
      | "EMAIL_TAKEN"
      | "PHONE_TAKEN"
      | "USERNAME_TAKEN"
      | "WEAK_PASSWORD"
      | "IDENTITY_EXCLUDED",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

/**
 * Deliberately modest: length carries far more entropy than character-class
 * rules, and complexity requirements mostly produce `Password1!`. Anything
 * stronger belongs in a breached-password check, not a regex.
 */
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

export interface RegisterParams {
  email: string;
  password: string;
  phoneNumber: string;
  /** YYYY-MM-DD. Required: an account with no proven age cannot legally bet. */
  dateOfBirth: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  /** ISO 3166-1 alpha-2. Defaults to NG. */
  country?: string;
  /** Someone else's referral code, as typed. Ignored if unrecognised. */
  referredByCode?: string;
  /** Set once the phone OTP has been verified. */
  phoneVerified?: boolean;
}

export interface RegisteredUser {
  userId: string;
  walletId: string;
  referralCode: string;
}

export class RegistrationService {
  constructor(private readonly wallet: WalletService = walletService) {}

  async register(params: RegisterParams): Promise<RegisteredUser> {
    const email = params.email.trim().toLowerCase();
    // Throws on a malformed number before anything is written.
    const phoneNumber = normalizePhone(params.phoneNumber);
    // Throws UnderageError / InvalidDateOfBirthError. Checked FIRST, before any
    // work is done on behalf of someone who must not have an account at all.
    const dateOfBirth = assertOldEnough(params.dateOfBirth);

    const username = params.username?.trim().toLowerCase() || null;
    if (username !== null && !/^[a-z0-9_]{3,20}$/.test(username)) {
      throw new RangeError("username must be 3-20 characters of a-z, 0-9 or underscore");
    }

    const country = (params.country ?? "NG").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new RangeError("country must be an ISO 3166-1 alpha-2 code");
    }

    if (
      params.password.length < MIN_PASSWORD_LENGTH ||
      params.password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new RegistrationError(
        "WEAK_PASSWORD",
        `password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
      );
    }

    // Hashed OUTSIDE the transaction: argon2id is deliberately slow, and
    // holding a database transaction open for the duration would pin a
    // connection for hundreds of milliseconds per signup.
    const passwordHash = await hashPassword(params.password);
    const referralCode = generateReferralCode();

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      await this.assertContactAvailable(tx, email, phoneNumber, username);
      const referrerId = await this.resolveReferrer(tx, params.referredByCode);

      const [user] = await tx.execute<{ id: string }>(sql`
        INSERT INTO users (
          email, phone_number, password_hash, status, kyc_level,
          first_name, last_name, username, date_of_birth, country,
          referral_code, referred_by, phone_verified_at
        )
        VALUES (
          ${email}, ${phoneNumber}, ${passwordHash}, 'ACTIVE', 0,
          ${params.firstName?.trim() || null}, ${params.lastName?.trim() || null},
          ${username}, ${dateOfBirth}::date, ${country},
          ${referralCode}, ${referrerId}::uuid,
          ${params.phoneVerified ? sql`now()` : sql`NULL`}
        )
        RETURNING id
      `);
      if (!user) throw new Error("user insert returned no row");

      // All three balance buckets, created together with the account. Lazy
      // creation would mean two concurrent credits could both find no row and
      // both insert, which the unique index turns into a failed deposit.
      await bucketService.ensureBuckets(tx, user.id);

      const [wallet] = await tx.execute<{ id: string }>(sql`
        SELECT id FROM wallets
        WHERE user_id = ${user.id}::uuid AND kind = 'USER'
          AND currency = 'NGN' AND bucket = 'CASH'
      `);
      if (!wallet) throw new Error("cash wallet was not created");

      // Preferences are created here rather than lazily so every account has a
      // row from the moment it exists — a missing row and a row of defaults
      // read the same to the product, and one of them needs a null check at
      // every call site.
      await tx.execute(sql`
        INSERT INTO user_preferences (user_id) VALUES (${user.id}::uuid)
        ON CONFLICT (user_id) DO NOTHING
      `);

      return { userId: user.id, walletId: wallet.id, referralCode };
    });
  }

  /**
   * Looks up who referred this signup.
   *
   * An unrecognised code is deliberately NOT an error: the person signing up
   * did nothing wrong, and failing their registration because a friend read a
   * character out wrong would be a poor trade. It simply records no referrer.
   */
  private async resolveReferrer(
    tx: WalletTransaction,
    code: string | undefined,
  ): Promise<string | null> {
    if (!code) return null;
    const normalized = normalizeReferralCode(code);
    if (!isValidReferralCode(normalized)) return null;

    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM users WHERE referral_code = ${normalized}
    `);
    return row?.id ?? null;
  }

  /**
   * Rejects an email or phone already in use.
   *
   * Checked explicitly rather than relying on the unique constraint alone, so
   * the caller gets a typed reason instead of a raw 23505 — but the
   * constraint is still what makes it correct under a concurrent signup race.
   */
  private async assertContactAvailable(
    tx: WalletTransaction,
    email: string,
    phoneNumber: string,
    username: string | null,
  ): Promise<void> {
    const [taken] = await tx.execute<{
      by_email: boolean;
      by_phone: boolean;
      by_username: boolean;
    }>(sql`
      SELECT
        bool_or(email = ${email})              AS by_email,
        bool_or(phone_number = ${phoneNumber}) AS by_phone,
        bool_or(${username}::text IS NOT NULL AND username = ${username}) AS by_username
      FROM users
      WHERE email = ${email}
         OR phone_number = ${phoneNumber}
         OR (${username}::text IS NOT NULL AND username = ${username})
    `);

    if (taken?.by_email) {
      throw new RegistrationError("EMAIL_TAKEN", "an account with this email already exists");
    }
    if (taken?.by_phone) {
      // Phone reuse matters more than it looks: the number is the OTP
      // destination and a contact point for self-exclusion, so sharing one
      // across accounts undermines both.
      throw new RegistrationError("PHONE_TAKEN", "an account with this phone number already exists");
    }
    if (taken?.by_username) {
      throw new RegistrationError("USERNAME_TAKEN", "that username is taken");
    }
  }

  /**
   * Blocks signup by someone whose identity is on the exclusion register.
   *
   * Only usable once an identity number is available — at KYC, not at signup,
   * since nothing verifiable exists yet. Registration is therefore NOT the
   * place self-exclusion is enforced; KYC and bet placement are. This exists
   * for flows that collect a BVN up front.
   */
  async assertIdentityNotExcluded(params: { bvn?: string; nin?: string }): Promise<void> {
    const hashes = [
      params.bvn ? hashBvn(params.bvn) : null,
      params.nin ? hashNin(params.nin) : null,
    ].filter((hash): hash is string => hash !== null);
    if (hashes.length === 0) return;

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM self_exclusions
        WHERE identity_hash IN (${sql.join(hashes.map((h) => sql`${h}`), sql`, `)})
          AND (until IS NULL OR until > now())
      `);
      if (Number(row?.n ?? 0) > 0) {
        throw new RegistrationError(
          "IDENTITY_EXCLUDED",
          "this identity is self-excluded and cannot open an account",
        );
      }
    });
  }
}

export const registrationService = new RegistrationService();
