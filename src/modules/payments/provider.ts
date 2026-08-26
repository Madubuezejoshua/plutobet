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
