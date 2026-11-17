import { randomUUID } from "node:crypto";
import type {
  BankOption,
  DepositWebhookEvent,
  PaymentProvider,
  ResolvedBankAccount,
  TransferResult,
  VirtualAccountDetails,
} from "./provider";
import { AccountResolutionError } from "./provider";

/**
 * ⚠️ DEVELOPMENT PROVIDER — MOVES NO REAL MONEY. ⚠️
 *
 * Used only when PAYSTACK_SECRET_KEY is absent, so a developer can exercise
 * the deposit and withdrawal flows end to end without credentials.
 *
 * The master build rules forbid unmarked mock data and forbid pretending a
 * fake provider is real, so this one is loud about what it is:
 *
 *   - `name` is "sandbox", which is what gets written to the withdrawal row
 *     and shown in the admin screen. Nobody reading the record can mistake a
 *     sandbox payout for a bank transfer.
 *   - Every call logs a warning.
 *   - `createPaymentProvider()` refuses to return this in production.
 *
 * It deliberately does NOT auto-succeed transfers. A provider that instantly
 * reports PAID would hide every bug in the pending-state handling — which is
 * the part that actually breaks in production. Transfers land in PROCESSING
 * and settle only when a webhook is replayed against them, exactly like the
 * real rail.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = "sandbox";

  constructor() {
    console.warn(
      "[payments] SANDBOX PROVIDER ACTIVE — no real money will move. " +
        "Set PAYSTACK_SECRET_KEY to use the live rail.",
    );
  }

  parseWebhook(rawBody: string): DepositWebhookEvent | null {
    // No signature check: there is no secret to sign with. This is the single
    // reason `createPaymentProvider` refuses to hand this back in production —
    // an unauthenticated deposit webhook is anyone crediting themselves.
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const eventName = typeof payload.event === "string" ? payload.event : "";
    if (!eventName.startsWith("charge.")) return null;

    return {
      providerRef: String(data.reference ?? randomUUID()),
      amountMinor: BigInt(String(data.amount ?? "0")),
      status: eventName === "charge.success" ? "SUCCEEDED" : "PENDING",
      virtualAccountRef:
        typeof data.account_number === "string" ? data.account_number : undefined,
      customerRef: typeof data.user_id === "string" ? data.user_id : undefined,
      raw: payload,
    };
  }

  async createVirtualAccount(params: { userId: string }): Promise<VirtualAccountDetails> {
    console.warn("[payments] sandbox virtual account issued for", params.userId);
    // Deterministic from the user id so repeated calls are stable, and clearly
    // fake: no real NUBAN starts 0000.
    const suffix = params.userId.replace(/\D/g, "").padStart(6, "0").slice(-6);
    return {
      providerRef: `sandbox-${params.userId}`,
      accountNumber: `0000${suffix}`,
      accountName: "SANDBOX — NOT A REAL ACCOUNT",
      bankName: "Sandbox Bank",
    };
  }

  /**
   * Two obviously fake banks.
   *
   * NOT a copy of the real Nigerian bank list. A development adapter returning
   * plausible-looking NIP codes would be the exact failure this interface
   * exists to prevent: somebody would eventually ship against it, and a code
   * that looks real and is wrong sends money to the wrong institution. The
   * names say what they are.
   */
  async listBanks(): Promise<BankOption[]> {
    return [
      { code: "000000", name: "Sandbox Bank — NOT REAL", slug: "sandbox-bank" },
      { code: "000001", name: "Sandbox Microfinance — NOT REAL", slug: "sandbox-mfb" },
    ];
  }

  /**
   * A NAME THAT CANNOT BE MISTAKEN FOR A VERIFIED ONE.
   *
   * It says NOT REAL, in capitals, in the string a customer would see and in
   * the string that would land on a payout record. That is deliberate and it is
   * the same reasoning as the bank list above: a development adapter that
   * returned "Joshua Madubueze" would be indistinguishable from a real
   * verification, and somebody would eventually ship against it and believe an
   * account had been checked when nothing had.
   *
   * `sandbox: true` is the machine-readable half. Nothing downstream should
   * have to inspect the name to work out whether anything was verified — a
   * caller that decides by string content is one that will eventually decide
   * wrong.
   *
   * It still REFUSES an unknown bank code, so the sandbox exercises the
   * not-found path rather than answering yes to everything. A stub that always
   * succeeds tests only the happy path, and the happy path is not where
   * withdrawals go wrong.
   */
  async resolveBankAccount(params: {
    bankCode: string;
    accountNumber: string;
  }): Promise<ResolvedBankAccount> {
    const known = await this.listBanks();
    if (!known.some((bank) => bank.code === params.bankCode)) {
      throw new AccountResolutionError(
        "NOT_FOUND",
        "we could not find an account with that number at that bank",
      );
    }
    // One reserved number that always fails, so the refusal path is reachable
    // from a browser without needing a provider to be down.
    if (params.accountNumber === "0000000000") {
      throw new AccountResolutionError(
        "NOT_FOUND",
        "we could not find an account with that number at that bank",
      );
    }
    return {
      accountNumber: params.accountNumber,
      bankCode: params.bankCode,
      accountName: `SANDBOX ACCOUNT ${params.accountNumber} — NOT REAL, NOT VERIFIED`,
      sandbox: true,
    };
  }

  async initiateTransfer(params: { reference: string }): Promise<TransferResult> {
    console.warn(
      `[payments] sandbox transfer ${params.reference} accepted — NO MONEY MOVED. ` +
        "It will stay PROCESSING until a transfer webhook is replayed against it.",
    );
    return { providerRef: `sandbox-transfer-${params.reference}`, status: "PROCESSING" };
  }
}
