import type { PaymentProvider } from "./provider";
import { PaystackProvider } from "./paystack";
import { SandboxPaymentProvider } from "./sandbox-provider";

/**
 * Chooses the payment rail.
 *
 * Live when credentials exist, sandbox otherwise — with one hard rule: the
 * sandbox provider is NEVER returned in production.
 *
 * That rule is not tidiness. The sandbox provider does not verify webhook
 * signatures, because it has no secret to verify against. Running it in
 * production would mean anyone who found the webhook URL could POST a
 * `charge.success` and credit themselves. Failing to start is strictly better
 * than starting with an open door to the ledger.
 */
export function createPaymentProvider(): PaymentProvider {
  if (process.env.PAYSTACK_SECRET_KEY) return new PaystackProvider();

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PAYSTACK_SECRET_KEY is required in production. Refusing to start with the " +
        "sandbox payment provider, which does not verify webhook signatures.",
    );
  }

  return new SandboxPaymentProvider();
}

/** True when real money can move. Used to warn operators in the admin UI. */
export function isLivePaymentRail(): boolean {
  return Boolean(process.env.PAYSTACK_SECRET_KEY);
}

let cached: PaymentProvider | undefined;

/**
 * The shared instance.
 *
 * Built lazily so a process that never touches payments — the odds sync
 * worker, say — starts without payment credentials.
 */
export function paymentProvider(): PaymentProvider {
  cached ??= createPaymentProvider();
  return cached;
}
