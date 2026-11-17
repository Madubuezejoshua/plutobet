import { isReviewEnvironment } from "@/lib/review-mode";
import type { PaymentProvider } from "./provider";
import { AccountResolutionError } from "./provider";
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

let cachedReadOnly: PaymentProvider | undefined;

/**
 * The provider for READ-ONLY lookups: the bank list, and account resolution.
 *
 * WHY THIS IS SEPARATE FROM `paymentProvider()`, AND WHY THE LINE IS DRAWN
 * EXACTLY HERE.
 *
 * `createPaymentProvider()` refuses to hand back the sandbox in production, and
 * that refusal must stand: the sandbox verifies no webhook signature, so
 * running it on a real deployment would let anyone who found the webhook URL
 * POST a `charge.success` and credit themselves. Nothing below relaxes that.
 *
 * But the review server IS a production build — deliberately, because a
 * development build is not the artefact anyone ships — and on it that refusal
 * threw for every bank-list fetch and would have thrown for every account
 * resolution. The observed symptom was `[payments] bank list unavailable` in
 * the log and an empty picker on screen, and a **500** from the resolution
 * route: a money form failing with an internal error because no key exists.
 *
 * So the seam is opened for the two operations that CANNOT be abused by
 * opening it:
 *
 *   - `listBanks` returns two banks named "NOT REAL" with codes that collide
 *     with nothing.
 *   - `resolveBankAccount` returns a name that says NOT REAL and NOT VERIFIED,
 *     and carries `sandbox: true` so no caller has to read the string.
 *
 * Neither verifies a signature. Neither moves money. Neither creates a
 * transfer recipient. `parseWebhook` and `initiateTransfer` still go through
 * `paymentProvider()` and still refuse, which is the whole point: this is not
 * "sandbox allowed in production", it is "two read-only calls may answer on a
 * machine that has already proved it can reach nothing real".
 *
 * `isReviewEnvironment()` is false whenever PAYSTACK_SECRET_KEY is set, so this
 * branch and the live one cannot both be reachable in the same process.
 */
export function paymentProviderForReads(): PaymentProvider {
  if (process.env.PAYSTACK_SECRET_KEY) return paymentProvider();
  if (isReviewEnvironment()) {
    cachedReadOnly ??= new SandboxPaymentProvider();
    return cachedReadOnly;
  }
  // Not configured and not a review server: say so in the vocabulary the
  // callers already handle, rather than throwing a raw Error that becomes a
  // 500 on a withdrawal form.
  throw new AccountResolutionError(
    "NOT_CONFIGURED",
    "no payment provider is configured, so bank details cannot be checked",
  );
}
