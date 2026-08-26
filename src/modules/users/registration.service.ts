import { sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { hashBvn, hashNin } from "../kyc/identity";
import { normalizePhone } from "../notifications/phone";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";

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
    readonly code: "EMAIL_TAKEN" | "PHONE_TAKEN" | "WEAK_PASSWORD" | "IDENTITY_EXCLUDED",
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
  /** Set once the phone OTP has been verified. */
  phoneVerified?: boolean;
}

export interface RegisteredUser {
  userId: string;
  walletId: string;
}

export class RegistrationService {
  constructor(private readonly wallet: WalletService = walletService) {}

  async register(params: RegisterParams): Promise<RegisteredUser> {
    const email = params.email.trim().toLowerCase();
    // Throws on a malformed number before anything is written.
    const phoneNumber = normalizePhone(params.phoneNumber);

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

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      await this.assertContactAvailable(tx, email, phoneNumber);

      const [user] = await tx.execute<{ id: string }>(sql`
        INSERT INTO users (email, phone_number, password_hash, status, kyc_level)
        VALUES (${email}, ${phoneNumber}, ${passwordHash}, 'ACTIVE', 0)
        RETURNING id
      `);
      if (!user) throw new Error("user insert returned no row");

      const [wallet] = await tx.execute<{ id: string }>(sql`
        INSERT INTO wallets (kind, user_id, currency, cached_balance_minor)
        VALUES ('USER', ${user.id}::uuid, 'NGN', 0)
        RETURNING id
      `);
      if (!wallet) throw new Error("wallet insert returned no row");

      return { userId: user.id, walletId: wallet.id };
    });
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
  ): Promise<void> {
    const [taken] = await tx.execute<{ by_email: boolean; by_phone: boolean }>(sql`
      SELECT
        bool_or(email = ${email})        AS by_email,
        bool_or(phone_number = ${phoneNumber}) AS by_phone
      FROM users
      WHERE email = ${email} OR phone_number = ${phoneNumber}
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
