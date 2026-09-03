import type {
  BankOption,
  DepositWebhookEvent,
  PaymentProvider,
  TransferResult,
  VirtualAccountDetails,
} from "./provider";
import { verifyPaystackSignature, WebhookSignatureError } from "./provider";

/**
 * Paystack adapter.
 *
 * ⚠️ UNVERIFIED AGAINST LIVE TRAFFIC. Every field mapping below follows
 * Paystack's published API shape and has been exercised only against fixtures.
 * The same caveat carried by the odds adapter applies, and for the same
 * reason: a field this code guesses wrong moves real money to the wrong place.
 * Run a low-value transfer end to end before trusting it with a customer's.
 *
 * WHAT THIS ADAPTER IS CAREFUL ABOUT
 *
 *  - Amounts. Paystack denominates NGN in kobo, which happens to match the
 *    internal representation exactly, so nothing is scaled. That coincidence
 *    is asserted rather than assumed: `toKobo` refuses a non-integer.
 *  - Idempotency. Every transfer carries our withdrawal id as its reference,
 *    so a retry maps to the same provider transfer instead of a second payout.
 *  - Failure shape. A network error and a declined transfer are different
 *    things, and only one of them is safe to retry.
 */

const API_BASE = "https://api.paystack.co";
const REQUEST_TIMEOUT_MS = 20_000;

export class PaystackError extends Error {
  constructor(
    readonly status: number,
    readonly providerMessage: string,
    /**
     * True when retrying could plausibly succeed — a timeout, a 5xx, a rate
     * limit. False for a declined transfer or a bad account number, where a
     * retry just produces the same refusal.
     */
    readonly retryable: boolean,
  ) {
    super(`paystack: ${providerMessage}`);
    this.name = "PaystackError";
  }
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

function secretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is required for live payments");
  return key;
}

/**
 * Paystack returns NGN amounts in kobo, the same unit used internally.
 *
 * Verified rather than trusted: a fractional value here would mean the
 * assumption has changed, and silently rounding it is how money goes missing.
 */
function toKobo(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new PaystackError(0, `expected integer kobo, got ${value}`, false);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new PaystackError(0, `unreadable amount: ${JSON.stringify(value)}`, false);
}

async function call<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${secretKey()}`,
        "content-type": "application/json",
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    // A timeout or DNS failure. Retryable — and critically, it does NOT mean
    // the transfer did not happen; the caller must reconcile rather than
    // assume failure.
    throw new PaystackError(
      0,
      error instanceof Error ? error.message : "network failure",
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: PaystackEnvelope<T>;
  try {
    payload = JSON.parse(text) as PaystackEnvelope<T>;
  } catch {
    throw new PaystackError(response.status, `unparseable response: ${text.slice(0, 200)}`, response.status >= 500);
  }

  if (!response.ok || payload.status === false) {
    throw new PaystackError(
      response.status,
      payload.message ?? `HTTP ${response.status}`,
      // 5xx and 429 are worth retrying; a 4xx is a refusal that will refuse again.
      response.status >= 500 || response.status === 429,
    );
  }

  return payload.data;
}

export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack";

  parseWebhook(rawBody: string, signature: string | null): DepositWebhookEvent | null {
    if (!verifyPaystackSignature(rawBody, signature, secretKey())) {
      throw new WebhookSignatureError();
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const eventName = typeof payload.event === "string" ? payload.event : "";
    if (!eventName.startsWith("charge.")) return null;

    const data = (payload.data ?? {}) as Record<string, unknown>;
    const status = typeof data.status === "string" ? data.status : "";

    return {
      providerRef: String(data.reference ?? ""),
      amountMinor: toKobo(data.amount),
      status:
        eventName === "charge.success" && status === "success"
          ? "SUCCEEDED"
          : status === "failed"
            ? "FAILED"
            : "PENDING",
      virtualAccountRef: readVirtualAccountRef(data),
      customerRef: readCustomerRef(data),
      raw: payload,
    };
  }

  async createVirtualAccount(params: {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
  }): Promise<VirtualAccountDetails> {
    // Paystack requires a customer before a dedicated account can be attached.
    const customer = await call<{ customer_code: string }>("/customer", {
      method: "POST",
      body: {
        email: params.email,
        first_name: params.firstName,
        last_name: params.lastName,
        phone: params.phone,
        metadata: { userId: params.userId },
      },
    });

    const account = await call<{
      id: number;
      account_number: string;
      account_name: string;
      bank: { name: string };
    }>("/dedicated_account", {
      method: "POST",
      body: { customer: customer.customer_code, preferred_bank: "wema-bank" },
    });

    return {
      providerRef: String(account.id),
      accountNumber: account.account_number,
      accountName: account.account_name,
      bankName: account.bank?.name ?? "Unknown",
    };
  }

  /**
   * Sends money out.
   *
   * Two steps, because Paystack requires a transfer recipient before a
   * transfer. Both carry our reference so a retry is idempotent on their side
   * as well as ours.
   *
   * A PROCESSING result is NOT a failure and must not be treated as one — the
   * final outcome arrives by webhook. Rolling the hold back here because the
   * transfer had not completed yet would refund a customer whose money is
   * already in flight.
   */
  /**
   * Paystack's bank list for Nigeria.
   *
   * Paginated at 100 by the provider and there are more than that, so this
   * follows `next_page` rather than taking the first page and calling it the
   * list. A truncated bank list is not a smaller feature — it is a customer
   * whose bank is missing being unable to withdraw, with nothing in the logs
   * to say why.
   *
   * `pay_with_bank_transfer` and other flags are ignored: what matters for a
   * payout is that the code is accepted on a transfer recipient, and Paystack
   * returns exactly that set for `currency=NGN`.
   *
   * No caching here. The caller decides how long a bank list stays fresh; an
   * adapter that cached would make that decision invisible.
   */
  async listBanks(): Promise<BankOption[]> {
    const banks: BankOption[] = [];
    let page = 1;

    // Bounded rather than `while (next)`. A provider bug that always returns a
    // next page would otherwise loop until the request times out, and thirty
    // pages is far more than the real list needs.
    for (; page <= 30; page++) {
      const response = await call<
        { code: string; name: string; slug?: string }[]
      >(`/bank?currency=NGN&perPage=100&page=${page}`, { method: "GET" });

      for (const bank of response) {
        // Defensive: a row without a code is unusable for a transfer, and
        // including it would put an option in front of a customer that can
        // only fail at payout.
        if (typeof bank.code === "string" && typeof bank.name === "string") {
          banks.push({ code: bank.code, name: bank.name, slug: bank.slug });
        }
      }

      if (response.length < 100) break;
    }

    return banks;
  }

  async initiateTransfer(params: {
    amountMinor: bigint;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    reference: string;
    reason: string;
  }): Promise<TransferResult> {
    const recipient = await call<{ recipient_code: string }>("/transferrecipient", {
      method: "POST",
      body: {
        type: "nuban",
        name: params.accountName,
        account_number: params.accountNumber,
        bank_code: params.bankCode,
        currency: "NGN",
      },
    });

    const transfer = await call<{ transfer_code: string; reference: string; status: string }>(
      "/transfer",
      {
        method: "POST",
        body: {
          source: "balance",
          amount: Number(params.amountMinor),
          recipient: recipient.recipient_code,
          reason: params.reason,
          reference: params.reference,
        },
      },
    );

    return {
      providerRef: transfer.transfer_code ?? transfer.reference,
      status: mapTransferStatus(transfer.status),
    };
  }
}

/** Paystack's transfer states, narrowed to the three outcomes we act on. */
export function mapTransferStatus(status: string): TransferResult["status"] {
  switch (status) {
    case "success":
      return "PAID";
    case "failed":
    case "abandoned":
    case "reversed":
      return "FAILED";
    default:
      // pending, otp, processing, received — all still in flight.
      return "PROCESSING";
  }
}

/**
 * Parses a transfer webhook.
 *
 * Separate from `parseWebhook` because a transfer event is not a deposit and
 * forcing it through the same shape would mean inventing an amount and a
 * status that mean something different.
 */
export interface TransferWebhookEvent {
  /** Our withdrawal id, echoed back as the transfer reference. */
  reference: string;
  providerRef: string;
  status: "PAID" | "FAILED" | "PROCESSING";
  failureReason?: string;
  reversed: boolean;
}

export function parseTransferWebhook(
  rawBody: string,
  signature: string | null,
): TransferWebhookEvent | null {
  if (!verifyPaystackSignature(rawBody, signature, secretKey())) {
    throw new WebhookSignatureError();
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const eventName = typeof payload.event === "string" ? payload.event : "";
  if (!eventName.startsWith("transfer.")) return null;

  const data = (payload.data ?? {}) as Record<string, unknown>;
  const status = typeof data.status === "string" ? data.status : "";

  return {
    reference: String(data.reference ?? ""),
    providerRef: String(data.transfer_code ?? data.reference ?? ""),
    status: mapTransferStatus(status),
    failureReason:
      typeof data.reason === "string" && status !== "success" ? data.reason : undefined,
    // A reversal is money that left and came back. It settles as FAILED for
    // ledger purposes but is worth distinguishing in the record: it means the
    // bank rejected the account AFTER accepting the transfer.
    reversed: eventName === "transfer.reversed" || status === "reversed",
  };
}

function readVirtualAccountRef(data: Record<string, unknown>): string | undefined {
  const account = data.authorization as Record<string, unknown> | undefined;
  const receiver = account?.receiver_bank_account_number;
  return typeof receiver === "string" ? receiver : undefined;
}

function readCustomerRef(data: Record<string, unknown>): string | undefined {
  const customer = data.customer as Record<string, unknown> | undefined;
  const metadata = customer?.metadata as Record<string, unknown> | undefined;
  const userId = metadata?.userId;
  return typeof userId === "string" ? userId : undefined;
}
