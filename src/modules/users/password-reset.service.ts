import { sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { createOtpService, OtpError, type OtpService } from "../notifications/otp.service";
import { walletService, WalletService } from "../wallet/wallet.service";
import { sessionService, SessionService } from "./session.service";

/**
 * Password reset by emailed code.
 *
 * Built on the existing OTP module rather than a bespoke token table, because
 * everything a reset token needs — single use, short expiry, hashed at rest,
 * attempt cap, per-destination and per-IP rate limiting — was already solved
 * there and tested. A second, subtly weaker implementation of the same idea is
 * how the weaker one ends up being the one an attacker uses.
 *
 * THE ENUMERATION RULE
 * `request()` reports success whether or not the address belongs to an
 * account. A reset form that says "no such user" is a free tool for confirming
 * which emails are registered on a gambling site, which is a privacy problem
 * well before it is a security one.
 */

export class PasswordResetError extends Error {
  constructor(
    readonly code: "INVALID_CODE" | "WEAK_PASSWORD",
    message: string,
  ) {
    super(message);
    this.name = "PasswordResetError";
  }
}

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

export class PasswordResetService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly otp: OtpService = createOtpService(),
    private readonly sessions: SessionService = sessionService,
  ) {}

  /**
   * Sends a reset code, if the address belongs to an account.
   *
   * Always resolves. The `devCode` is passed through only when no real email
   * provider is configured, which is how local development works without
   * inspecting the database.
   */
  async request(params: { email: string; ip: string }): Promise<{ devCode?: string }> {
    const email = params.email.trim().toLowerCase();

    const userId = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ id: string; status: string }>(sql`
        SELECT id, status::text AS status FROM users WHERE email = ${email}
      `);
      if (!row) return null;
      // A closed or self-excluded account must not be recoverable: resetting
      // the password would be the first step in getting back in.
      if (row.status === "CLOSED" || row.status === "SELF_EXCLUDED") return null;
      return row.id;
    });

    if (!userId) {
      // Deliberately silent. The caller tells the user "if that address has an
      // account, a code is on its way" either way.
      return {};
    }

    const issued = await this.otp.issue({
      destination: email,
      channel: "EMAIL",
      purpose: "PASSWORD_RESET",
      userId,
      ip: params.ip,
    });

    return issued.devCode ? { devCode: issued.devCode } : {};
  }

  /**
   * Consumes a code and sets a new password.
   *
   * Every live session for the account is revoked. A reset is very often
   * somebody recovering an account they believe is compromised, and leaving
   * the intruder signed in would make the reset pointless.
   */
  async reset(params: { email: string; code: string; newPassword: string }): Promise<void> {
    if (
      params.newPassword.length < MIN_PASSWORD_LENGTH ||
      params.newPassword.length > MAX_PASSWORD_LENGTH
    ) {
      throw new PasswordResetError(
        "WEAK_PASSWORD",
        `password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
      );
    }

    const email = params.email.trim().toLowerCase();

    // Verified in its own transaction, BEFORE the password work. The OTP
    // service records the attempt durably even when verification fails, which
    // only holds if the failure is not rolled back by an enclosing
    // transaction — the exact bug that once made the attempt cap useless.
    let userId: string | null;
    try {
      ({ userId } = await this.otp.verify({
        destination: email,
        channel: "EMAIL",
        purpose: "PASSWORD_RESET",
        code: params.code,
      }));
    } catch (error) {
      if (error instanceof OtpError) {
        // Every OTP failure reason collapses into one message. Distinguishing
        // "expired" from "wrong" tells an attacker whether they had the right
        // address and a stale code.
        throw new PasswordResetError("INVALID_CODE", "that code is not valid — request a new one");
      }
      throw error;
    }

    if (!userId) {
      throw new PasswordResetError("INVALID_CODE", "that code is not valid — request a new one");
    }

    // Hashed outside the transaction: argon2id is slow by design.
    const passwordHash = await hashPassword(params.newPassword);

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE users
        SET password_hash = ${passwordHash}, must_change_password = false, updated_at = now()
        WHERE id = ${userId}::uuid
      `);
    });

    await this.sessions.revokeAll({ userId, reason: "password reset" });
  }
}

export const passwordResetService = new PasswordResetService();
