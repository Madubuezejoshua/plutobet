import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { rateLimiter, type RateLimiter } from "@/lib/api/rate-limit";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import { normalizeEmailDestination, normalizePhone } from "./phone";
import {
  ConsoleEmailProvider,
  ConsoleSmsProvider,
  DeliveryFailedError,
  type EmailProvider,
  type SmsProvider,
} from "./provider";
import { ResendEmailProvider } from "./resend";
import {
  ReviewMailboxEmailProvider,
  ReviewMailboxSmsProvider,
  reviewMailboxEnabled,
} from "./review-mailbox";
import { TermiiSmsProvider } from "./termii";

/**
 * One-time codes.
 *
 * The code itself is weak by design — six digits is 10^6, which a machine
 * walks in seconds. Everything that makes OTP safe is the surrounding
 * controls, so they are the parts to read carefully:
 *
 *   - a short expiry, so a stolen code is useless quickly;
 *   - an attempt cap, so the keyspace cannot be walked;
 *   - single use, so a code observed in transit cannot be replayed;
 *   - send rate limits, because SMS costs money and an unthrottled endpoint
 *     is both a bill and a way to harass a stranger's phone;
 *   - constant-time comparison, so timing does not leak the code.
 *
 * Remove any one of those and the remaining five do not compensate.
 */

export type OtpChannel = "SMS" | "EMAIL";
export type OtpPurpose =
  | "PHONE_VERIFY"
  | "EMAIL_VERIFY"
  | "LOGIN"
  | "WITHDRAWAL_CONFIRM"
  | "PASSWORD_RESET";

const CODE_LENGTH = 6;
const TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

/**
 * Send throttles.
 *
 * Per destination stops one number being bombarded (and the bill that comes
 * with it); per IP stops one actor enumerating many numbers.
 */
const SEND_RULES = {
  perDestination: { limit: 3, windowSeconds: 15 * 60 },
  perIp: { limit: 20, windowSeconds: 60 * 60 },
} as const;

export class OtpError extends Error {
  constructor(
    readonly code:
      | "RATE_LIMITED"
      | "NO_ACTIVE_CODE"
      | "EXPIRED"
      | "TOO_MANY_ATTEMPTS"
      | "INCORRECT",
    message: string,
  ) {
    super(message);
    this.name = "OtpError";
  }
}

/**
 * No delivery provider is configured, and the console fallback is not allowed
 * here.
 *
 * TYPED, AND SEPARATE FROM `OtpError`, BECAUSE OF WHAT IT LEAKED.
 *
 * This condition used to be a plain `Error`. `password-reset` catches `OtpError`
 * and answers with one generic message either way — deliberately, because a
 * reset form that distinguishes a real address from an unknown one is a free
 * membership oracle for a gambling site. A plain `Error` fell through that
 * catch and became a 500, while an address with NO account short-circuited
 * before any provider was touched and returned 200.
 *
 * So the endpoint whose entire design goal is "answer identically" answered
 * **500 for a customer and 200 for a stranger** the moment it ran in production
 * without an email provider, which is the state it is deployed in today. Found
 * by the browser security pass, not by reading the route.
 *
 * It is not folded into `OtpError` because the registration route must NOT
 * treat it as a rate limit — telling a caller "too many codes requested" when
 * the truth is "this deployment cannot send anything" is a different lie.
 * Each route now decides, and both decide address-independently.
 */
export class OtpProviderUnavailableError extends Error {
  /**
   * The message stays LONG and specific on purpose.
   *
   * Making this a typed error first replaced it with a terse one, and
   * `otp-production-guard.acceptance.spec.ts` failed — correctly. This text is
   * an OPERATOR's only clue: it has to name the variables to configure and
   * explain the consequence of the fallback, because "no provider configured"
   * tells somebody staring at a log nothing they can act on.
   *
   * It never reaches a customer. Both routes answer with their own curated 503
   * wording precisely so this can stay detailed.
   */
  constructor(readonly channel: OtpChannel) {
    super(
      `refusing to issue a ${channel} code in production with no provider configured: ` +
        "the console fallback returns the one-time code in the API response, which would let " +
        "anyone verify a destination they do not control. Configure " +
        (channel === "SMS"
          ? "TERMII_API_KEY and TERMII_SENDER_ID"
          : "RESEND_API_KEY and RESEND_FROM"),
    );
    this.name = "OtpProviderUnavailableError";
  }
}

/**
 * Whether a code could be delivered at all on this channel.
 *
 * Depends only on configuration — never on the destination — so a caller can
 * check it BEFORE looking an address up and answer the same way for everybody.
 * That ordering is the fix; the type above is only what makes it expressible.
 */
export function otpDeliveryAvailable(channel: OtpChannel): boolean {
  const configured =
    channel === "SMS"
      ? Boolean(process.env.TERMII_API_KEY && process.env.TERMII_SENDER_ID)
      : Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
  /*
   * A REVIEW SERVER CAN DELIVER, AND THAT IS NOT A LOOSENING.
   *
   * The review mailbox is a real delivery path: the message leaves the service
   * and lands somewhere the requester cannot see, which is the only property
   * that makes a one-time code worth anything at all. Reading it back requires
   * `/api/qa/mailbox`, which refuses under exactly the same four conditions
   * this does. What the console fallback did — hand the code straight back to
   * whoever asked for it — the mailbox never does.
   */
  if (reviewMailboxEnabled()) return true;
  // Outside production the console fallback is a legitimate delivery path.
  return configured || process.env.NODE_ENV !== "production";
}

/**
 * Codes are stored as HMAC digests under a server-held secret.
 *
 * A plain hash of six digits is trivially reversed by precomputation, so the
 * secret is what gives the digest any value at all. AUTH_SECRET is reused
 * rather than adding another key to manage — unlike the identity pepper this
 * one CAN be rotated freely, because in-flight codes expire in minutes.
 */
function hashCode(code: string, destination: string, purpose: OtpPurpose): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required to issue one-time codes");
  // Destination and purpose are bound into the digest so a code issued for
  // one thing cannot be replayed against another.
  return createHmac("sha256", secret).update(`${purpose}:${destination}:${code}`).digest("hex");
}

function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Cryptographically random, not Math.random: a guessable OTP is no OTP. */
function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

export interface IssueOtpParams {
  destination: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  userId?: string;
  /** For per-IP send throttling. */
  ip: string;
}

export interface IssuedOtp {
  destination: string;
  expiresAt: Date;
  /** Present ONLY when no real provider is configured (local development). */
  devCode?: string;
}

export class OtpService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly sms: SmsProvider = new ConsoleSmsProvider(),
    private readonly email: EmailProvider = new ConsoleEmailProvider(),
    private readonly limiter: RateLimiter = rateLimiter,
  ) {}

  /**
   * Issues a code and sends it.
   *
   * Any previously active code for the same destination and purpose is
   * invalidated first, so "resend" cannot be used to keep several valid codes
   * alive at once and multiply an attacker's guesses.
   */
  async issue(params: IssueOtpParams): Promise<IssuedOtp> {
    /*
     * THE CONSOLE FALLBACK IS A VERIFICATION BYPASS IN PRODUCTION.
     *
     * `devCode` at the end of this method is returned whenever the active
     * provider is the console one, so a production deployment missing vendor
     * keys would hand the one-time code straight back in the API response.
     * Anyone could then request a code for a destination they do not control
     * and verify it immediately — which also defeats self-exclusion and
     * duplicate-identity prevention, since both are keyed to a verified number.
     *
     * Checked FIRST, before the throttle is consumed or a row is written: a
     * request that must not succeed should not spend a rate-limit budget or
     * leave an OTP row behind.
     *
     * The check lives here rather than in `createOtpService` because refusing
     * at construction broke `next build` — password-reset.service.ts builds an
     * OtpService at module evaluation and the build runs with
     * NODE_ENV=production, so page-data collection threw on a machine that was
     * never going to serve a request. Guarding the dangerous operation is
     * narrower and more accurate than guarding the object that can perform it.
     */
    const usingConsole =
      params.channel === "SMS" ? this.sms.name === "console" : this.email.name === "console";

    if (usingConsole && process.env.NODE_ENV === "production") {
      /*
       * A TYPED error, so a caller can answer identically for every address.
       * As a plain `Error` this escaped the password-reset route's catch and
       * turned that endpoint into an account-enumeration oracle — see
       * `OtpProviderUnavailableError`.
       */
      throw new OtpProviderUnavailableError(params.channel);
    }

    const destination =
      params.channel === "SMS"
        ? normalizePhone(params.destination)
        : normalizeEmailDestination(params.destination);

    // Throttle BEFORE generating or sending: the cost being defended is the
    // SMS itself.
    const byDestination = await this.limiter.consume(
      `otp:dest:${params.purpose}`,
      destination,
      SEND_RULES.perDestination,
    );
    if (!byDestination.allowed) {
      throw new OtpError("RATE_LIMITED", "too many codes requested — try again shortly");
    }
    const byIp = await this.limiter.consume("otp:ip", params.ip, SEND_RULES.perIp);
    if (!byIp.allowed) {
      throw new OtpError("RATE_LIMITED", "too many codes requested — try again shortly");
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await this.invalidateActive(tx, destination, params.purpose);
      await tx.execute(sql`
        INSERT INTO otp_codes
          (destination, channel, purpose, user_id, code_hash, max_attempts, expires_at)
        VALUES (
          ${destination},
          ${params.channel}::otp_channel,
          ${params.purpose}::otp_purpose,
          ${params.userId ?? null},
          ${hashCode(code, destination, params.purpose)},
          ${MAX_ATTEMPTS},
          ${expiresAt.toISOString()}::timestamptz
        )
      `);
    });

    await this.deliver(destination, params, code);

    // Returned only when nothing real is configured, so local development and
    // tests can complete the flow. A configured deployment never sees this.
    return { destination, expiresAt, ...(usingConsole ? { devCode: code } : {}) };
  }

  /**
   * Verifies a code and consumes it.
   *
   * Every failure path increments the attempt counter, including a wrong code
   * — otherwise the cap protects nothing.
   */
  async verify(params: {
    destination: string;
    channel: OtpChannel;
    purpose: OtpPurpose;
    code: string;
  }): Promise<{ userId: string | null }> {
    const destination =
      params.channel === "SMS"
        ? normalizePhone(params.destination)
        : normalizeEmailDestination(params.destination);

    /**
     * The outcome is RETURNED from the transaction and thrown afterwards,
     * never thrown from inside it.
     *
     * Throwing inside rolls the transaction back — including the attempt
     * increment written moments earlier by the very failure being signalled.
     * The counter then never advances, the cap never trips, and all 10^6
     * codes become brute-forceable while the code looks correct. Committing
     * first and throwing second is the whole point of this shape.
     */
    type Outcome =
      | { kind: "OK"; userId: string | null }
      | { kind: "NO_ACTIVE_CODE" }
      | { kind: "EXPIRED" }
      | { kind: "TOO_MANY_ATTEMPTS" }
      | { kind: "INCORRECT" };

    const outcome = await this.wallet.withMoneyTransaction<Outcome>(async ({ tx }) => {
      // FOR UPDATE so concurrent guesses cannot both read attempts = 4.
      const [row] = await tx.execute<{
        id: string;
        user_id: string | null;
        code_hash: string;
        attempts: number;
        max_attempts: number;
        expired: boolean;
      }>(sql`
        SELECT id, user_id, code_hash, attempts, max_attempts,
               (expires_at <= now()) AS expired
        FROM otp_codes
        WHERE destination = ${destination}
          AND purpose = ${params.purpose}::otp_purpose
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `);

      if (!row) return { kind: "NO_ACTIVE_CODE" };
      if (row.expired) return { kind: "EXPIRED" };
      if (row.attempts >= row.max_attempts) return { kind: "TOO_MANY_ATTEMPTS" };

      const supplied = hashCode(params.code.trim(), destination, params.purpose);
      if (!digestsMatch(supplied, row.code_hash)) {
        await tx.execute(sql`
          UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ${row.id}::uuid
        `);
        return { kind: "INCORRECT" };
      }

      // Single use. Consuming inside the same transaction as the check means
      // two simultaneous submissions of a correct code cannot both succeed.
      await tx.execute(sql`
        UPDATE otp_codes SET consumed_at = now() WHERE id = ${row.id}::uuid
      `);

      return { kind: "OK", userId: row.user_id };
    });

    switch (outcome.kind) {
      case "OK":
        return { userId: outcome.userId };
      case "NO_ACTIVE_CODE":
        throw new OtpError("NO_ACTIVE_CODE", "request a new code");
      case "EXPIRED":
        throw new OtpError("EXPIRED", "that code has expired — request a new one");
      case "TOO_MANY_ATTEMPTS":
        throw new OtpError("TOO_MANY_ATTEMPTS", "too many attempts — request a new code");
      case "INCORRECT":
        // The same message whether the code was wrong or the cap was just
        // reached: distinguishing them tells an attacker how many tries remain.
        throw new OtpError("INCORRECT", "that code is not correct");
    }
  }

  private async invalidateActive(
    tx: WalletTransaction,
    destination: string,
    purpose: OtpPurpose,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE otp_codes SET consumed_at = now()
      WHERE destination = ${destination}
        AND purpose = ${purpose}::otp_purpose
        AND consumed_at IS NULL
    `);
  }

  private async deliver(
    destination: string,
    params: IssueOtpParams,
    code: string,
  ): Promise<void> {
    const body = `${code} is your Bet Platform code. It expires in ${TTL_SECONDS / 60} minutes. Never share it with anyone.`;
    let providerRef: string | null = null;
    let error: string | null = null;
    const provider = params.channel === "SMS" ? this.sms.name : this.email.name;

    try {
      const result =
        params.channel === "SMS"
          ? await this.sms.send(destination, body)
          : await this.email.send({
              to: destination,
              subject: "Your verification code",
              text: body,
            });
      providerRef = result.providerRef;
    } catch (deliveryError) {
      error =
        deliveryError instanceof DeliveryFailedError
          ? deliveryError.detail
          : "unknown delivery error";
    }

    // Logged whether or not it succeeded — a failed send is the thing support
    // needs to see when a user says "I never got the code". The body is NOT
    // recorded: it contains the code.
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO notification_deliveries
          (channel, destination, template, status, provider, provider_ref, error, user_id)
        VALUES (
          ${params.channel}::otp_channel,
          ${destination},
          ${`otp:${params.purpose}`},
          ${error ? "FAILED" : "SENT"}::delivery_status,
          ${provider},
          ${providerRef},
          ${error},
          ${params.userId ?? null}
        )
      `);
    });

    if (error) {
      throw new DeliveryFailedError(provider, error);
    }
  }
}

/**
 * Builds the service from configuration, falling back to console providers so
 * a developer without vendor keys can still complete the flow end to end.
 */
export function createOtpService(): OtpService {
  const hasSms = Boolean(process.env.TERMII_API_KEY && process.env.TERMII_SENDER_ID);
  const hasEmail = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);

  /*
   * THE REVIEW MAILBOX COMES FIRST, AND IT CANNOT COEXIST WITH A REAL VENDOR.
   *
   * `reviewMailboxEnabled()` is false whenever TERMII_API_KEY, RESEND_API_KEY
   * or any other live credential is present — that is one of its four
   * conditions, not a convention observed here. So this branch and the two
   * below are mutually exclusive BY CONSTRUCTION rather than by ordering, and
   * reordering them could not route a test message through a real vendor.
   */
  if (reviewMailboxEnabled()) {
    return new OtpService(
      walletService,
      new ReviewMailboxSmsProvider(),
      new ReviewMailboxEmailProvider(),
    );
  }

  const sms: SmsProvider = hasSms
    ? new TermiiSmsProvider(process.env.TERMII_API_KEY!, process.env.TERMII_SENDER_ID!)
    : new ConsoleSmsProvider();

  const email: EmailProvider = hasEmail
    ? new ResendEmailProvider(process.env.RESEND_API_KEY!, process.env.RESEND_FROM!)
    : new ConsoleEmailProvider();

  return new OtpService(walletService, sms, email);
}

export const otpService = new OtpService();
