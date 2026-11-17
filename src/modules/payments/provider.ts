import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Provider-agnostic payment contract.
 *
 * Same rule as the odds adapter: nothing outside this module imports a
 * Paystack type. Flutterwave is the documented backup rail, and swapping it
 * in should be a new adapter, not a rewrite of the deposit flow.
 */

export interface DepositWebhookEvent {
  /** Provider's own reference — the idempotency anchor. */
  providerRef: string;
  amountMinor: bigint;
  status: "SUCCEEDED" | "FAILED" | "PENDING";
  /** Set when the money arrived via a dedicated virtual account. */
  virtualAccountRef?: string;
  /** Present when the provider echoes our own customer identifier. */
  customerRef?: string;
  raw: Record<string, unknown>;
}

export interface TransferResult {
  providerRef: string;
  status: "PROCESSING" | "PAID" | "FAILED";
  failureReason?: string;
}

/**
 * One bank a customer can be paid to.
 *
 * `code` is the value the provider expects on a transfer — a NIP code for
 * Paystack. It is deliberately opaque to everything above this module: nothing
 * outside here should know what a NIP code looks like, and nothing anywhere
 * should carry a hand-typed list of them. A wrong code sends real money to the
 * wrong bank, so the only acceptable source is the provider itself.
 */
export interface BankOption {
  code: string;
  name: string;
  /** Present when the provider distinguishes a slug from a display name. */
  slug?: string;
}

/**
 * The provider's answer to "whose account is this?".
 *
 * `accountName` is THE PROVIDER'S, never the customer's. The withdrawal form
 * shows it read-only and the withdrawal route re-resolves rather than trusting
 * what came back in the request body: an account name posted by a browser is a
 * claim, and this is the only thing that turns it into a fact.
 *
 * `sandbox` marks an answer that came from the development adapter, so nothing
 * downstream can mistake "Sandbox — NOT REAL" for a verified identity. It is on
 * the type rather than left to a name-matching heuristic, because a caller
 * deciding by string content is a caller that will eventually decide wrong.
 */
export interface ResolvedBankAccount {
  accountNumber: string;
  bankCode: string;
  /** Exactly as the provider returned it. Never normalised or title-cased. */
  accountName: string;
  /** True when this came from the sandbox adapter and verifies nothing. */
  sandbox: boolean;
}

/** The provider could not name an account for that bank and number. */
export class AccountResolutionError extends Error {
  constructor(
    readonly reason: "NOT_FOUND" | "PROVIDER_UNAVAILABLE" | "NOT_CONFIGURED",
    message: string,
  ) {
    super(message);
    this.name = "AccountResolutionError";
  }
}

export interface VirtualAccountDetails {
  providerRef: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
}

export interface PaymentProvider {
  readonly name: string;

  /**
   * Verifies the webhook signature and parses the payload.
   *
   * Returns null when the payload is authentic but not a deposit event we
   * care about. THROWS when the signature does not verify — an unverified
   * webhook is an attacker crediting themselves, not a parsing problem.
   */
  parseWebhook(rawBody: string, signature: string | null): DepositWebhookEvent | null;

  createVirtualAccount(params: {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
  }): Promise<VirtualAccountDetails>;

  initiateTransfer(params: {
    amountMinor: bigint;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    /** Our withdrawal id, so a retry maps to the same provider transfer. */
    reference: string;
    reason: string;
  }): Promise<TransferResult>;

  /**
   * Every bank this provider can pay out to.
   *
   * Exists so no part of this codebase has to hold a bank list of its own.
   * Nigerian NIP codes change — banks merge, microfinance banks are added and
   * removed — and a list typed into source is wrong from the day it is written
   * and gets worse. A stale code does not fail loudly; it sends somebody's
   * withdrawal to a different institution.
   *
   * The caller caches the result. Implementations should not.
   */
  listBanks(): Promise<BankOption[]>;

  /**
   * Asks the provider who owns a bank account, before any money is held.
   *
   * WHY THIS IS ON THE INTERFACE AND NOT IN A ROUTE. A withdrawal used to carry
   * an `accountName` typed by the browser, and nothing checked it: the customer
   * could enter any name and the transfer was created with it. The number and
   * the code decide where the money lands, so a wrong name did not misdirect
   * funds — but it destroyed the one signal that the customer had entered
   * somebody else's account by mistake, and it meant the name on the payout
   * record was whatever had been typed.
   *
   * THROWS `AccountResolutionError` rather than returning null, so a caller
   * cannot treat "we could not check" as "it is fine". The three reasons are
   * distinguishable because they need different answers: NOT_FOUND is the
   * customer's typo, PROVIDER_UNAVAILABLE is ours to retry, and NOT_CONFIGURED
   * means no credential exists and nothing can be verified at all.
   */
  resolveBankAccount(params: {
    bankCode: string;
    accountNumber: string;
  }): Promise<ResolvedBankAccount>;
}

export class WebhookSignatureError extends Error {
  constructor() {
    // No detail: this message can reach logs an attacker may probe.
    super("webhook signature verification failed");
    this.name = "WebhookSignatureError";
  }
}

/**
 * Paystack signs webhooks as HMAC-SHA512 of the raw body under the secret key.
 *
 * The RAW body matters: re-serialising the parsed JSON changes key order and
 * whitespace, and the signature stops matching. Any framework that hands you
 * a parsed object has already destroyed the thing you need to verify.
 */
export function verifyPaystackSignature(
  rawBody: string,
  signature: string | null,
  secretKey: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha512", secretKey).update(rawBody, "utf8").digest("hex");
  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (provided.length !== computed.length) return false;
  // Constant time: a fast `===` leaks how much of a forged signature was
  // correct, which is enough to forge one byte at a time.
  return timingSafeEqual(provided, computed);
}
