import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapTransferStatus, parseTransferWebhook, PaystackProvider } from "../paystack";
import { WebhookSignatureError } from "../provider";
import { createPaymentProvider, isLivePaymentRail } from "../factory";
import { SandboxPaymentProvider } from "../sandbox-provider";

const SECRET = "sk_test_paystack_acceptance_secret";

function sign(body: string): string {
  return createHmac("sha512", SECRET).update(body, "utf8").digest("hex");
}

describe("paystack adapter", () => {
  // `vi.stubEnv` rather than assigning to process.env: NODE_ENV is not a
  // writable data property in this Node version, and vitest restores every
  // stub cleanly even when a test throws.
  beforeEach(() => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("transfer status mapping", () => {
    /*
     * The single most consequential mapping in the payments module.
     *
     * Calling a still-pending transfer FAILED refunds a customer whose money
     * is already in flight — paying them twice. Calling a failed transfer
     * PROCESSING strands their money indefinitely. Everything in between is
     * pending and must stay pending.
     */
    it("treats only an explicit success as paid", () => {
      expect(mapTransferStatus("success")).toBe("PAID");
    });

    it.each(["failed", "abandoned", "reversed"])("treats %s as failed", (status) => {
      expect(mapTransferStatus(status)).toBe("FAILED");
    });

    it.each(["pending", "otp", "processing", "received", "", "something-new"])(
      "leaves %s in flight rather than guessing",
      (status) => {
        expect(mapTransferStatus(status)).toBe("PROCESSING");
      },
    );
  });

  describe("webhook signatures", () => {
    const body = JSON.stringify({
      event: "charge.success",
      data: { reference: "ref_1", amount: 500_000, status: "success" },
    });

    it("accepts a correctly signed deposit webhook", () => {
      const event = new PaystackProvider().parseWebhook(body, sign(body));
      expect(event).not.toBeNull();
      expect(event!.providerRef).toBe("ref_1");
      expect(event!.amountMinor).toBe(500_000n);
      expect(event!.status).toBe("SUCCEEDED");
    });

    it("throws rather than returning null on a bad signature", () => {
      // Critically NOT a parse failure to be shrugged off: an unverified
      // webhook is someone crediting themselves.
      expect(() => new PaystackProvider().parseWebhook(body, "deadbeef")).toThrow(
        WebhookSignatureError,
      );
    });

    it("throws on a missing signature", () => {
      expect(() => new PaystackProvider().parseWebhook(body, null)).toThrow(
        WebhookSignatureError,
      );
    });

    it("rejects a body altered after signing", () => {
      const signature = sign(body);
      const tampered = body.replace("500000", "50000000");
      expect(() => new PaystackProvider().parseWebhook(tampered, signature)).toThrow(
        WebhookSignatureError,
      );
    });
  });

  describe("transfer webhooks", () => {
    function transferBody(event: string, status: string, reason?: string): string {
      return JSON.stringify({
        event,
        data: {
          reference: "3f7c1a52-9b3e-4a1d-8f2b-6c5d4e3a2b1c",
          transfer_code: "TRF_abc123",
          status,
          reason,
        },
      });
    }

    it("settles a successful transfer", () => {
      const body = transferBody("transfer.success", "success");
      const event = parseTransferWebhook(body, sign(body));
      expect(event!.status).toBe("PAID");
      expect(event!.reference).toBe("3f7c1a52-9b3e-4a1d-8f2b-6c5d4e3a2b1c");
      expect(event!.reversed).toBe(false);
    });

    it("carries the provider's reason on failure", () => {
      const body = transferBody("transfer.failed", "failed", "Account does not exist");
      const event = parseTransferWebhook(body, sign(body));
      expect(event!.status).toBe("FAILED");
      expect(event!.failureReason).toBe("Account does not exist");
    });

    /*
     * A reversal means the bank accepted the transfer and then sent it back —
     * different from one that never left, and worth distinguishing in the
     * record even though both settle as FAILED.
     */
    it("flags a reversal distinctly", () => {
      const body = transferBody("transfer.reversed", "reversed");
      const event = parseTransferWebhook(body, sign(body));
      expect(event!.status).toBe("FAILED");
      expect(event!.reversed).toBe(true);
    });

    it("ignores non-transfer events", () => {
      const body = JSON.stringify({ event: "charge.success", data: {} });
      expect(parseTransferWebhook(body, sign(body))).toBeNull();
    });

    it("refuses an unsigned transfer webhook", () => {
      const body = transferBody("transfer.success", "success");
      expect(() => parseTransferWebhook(body, null)).toThrow(WebhookSignatureError);
    });
  });
});

describe("payment provider selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the live rail when a key is present", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
    expect(createPaymentProvider().name).toBe("paystack");
    expect(isLivePaymentRail()).toBe(true);
  });

  it("falls back to the sandbox in development", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");
    vi.stubEnv("NODE_ENV", "development");

    const provider = createPaymentProvider();
    expect(provider).toBeInstanceOf(SandboxPaymentProvider);
    // The name reaches the withdrawal row and the admin screen, so nobody can
    // mistake a sandbox payout for a bank transfer.
    expect(provider.name).toBe("sandbox");
    expect(isLivePaymentRail()).toBe(false);
  });

  /*
   * The sandbox provider does not verify webhook signatures — it has no
   * secret to verify against. Running it in production would let anyone who
   * found the webhook URL credit themselves. Refusing to start is strictly
   * better than starting with an open door to the ledger.
   */
  it("refuses to start in production without a key", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");
    vi.stubEnv("NODE_ENV", "production");

    expect(() => createPaymentProvider()).toThrow(/PAYSTACK_SECRET_KEY is required in production/);
  });
});

describe("sandbox provider", () => {
  it("does not pretend a transfer succeeded", async () => {
    const result = await new SandboxPaymentProvider().initiateTransfer({ reference: "w-1" });
    // Auto-succeeding would hide every bug in the pending-state handling,
    // which is the part that actually breaks in production.
    expect(result.status).toBe("PROCESSING");
  });

  it("issues obviously fake account details", async () => {
    const account = await new SandboxPaymentProvider().createVirtualAccount({ userId: "abc123" });
    expect(account.accountName).toMatch(/SANDBOX/);
    expect(account.accountNumber).toMatch(/^0000/);
  });
});
