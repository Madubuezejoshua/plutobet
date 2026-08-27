import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { clientIp } from "@/lib/api/handler";
import { rateLimiter, RATE_RULES } from "@/lib/api/rate-limit";
import { depositService, UnattributableDepositError } from "@/modules/payments/deposit.service";
import type { DepositWebhookEvent } from "@/modules/payments/provider";
import { verifyPaystackSignature } from "@/modules/payments/provider";
import { mapTransferStatus } from "@/modules/payments/paystack";
import { withdrawalService } from "@/modules/payments/withdrawal.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDER = "paystack";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Paystack deposit webhook.
 *
 * NOT wrapped in the shared route helpers, for two reasons that both matter:
 *
 *  1. It must read the RAW request body. The signature is an HMAC over the
 *     exact bytes Paystack sent; parsing to JSON and re-serialising changes
 *     key order and whitespace, and verification then fails on legitimate
 *     traffic. Anything that hands you a parsed object has already destroyed
 *     the thing you need to verify.
 *
 *  2. Its failure semantics are inverted. For a normal route an error is a
 *     4xx to the caller; here a non-2xx makes Paystack retry, so an
 *     unattributable deposit must be ACKNOWLEDGED rather than rejected — it
 *     is a support problem, and retrying will not fix it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error("[paystack] PAYSTACK_SECRET_KEY is not configured");
    // 500 so Paystack retries once we are configured, rather than silently
    // dropping real deposits.
    return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 500 });
  }

  // Rate limit by IP BEFORE doing any work, but generously: the caller is a
  // provider retrying in good faith, and throttling it produces exactly the
  // duplicate deliveries we then have to de-duplicate.
  const outcome = await rateLimiter.consume("webhook", clientIp(request), RATE_RULES.webhook);
  if (!outcome.allowed) return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });

  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature");

  if (!verifyPaystackSignature(rawBody, signature, secret)) {
    // An unverified webhook is someone trying to credit themselves, not a
    // parsing problem. Say nothing useful back.
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Signed but unparseable: acknowledge, because retrying cannot help.
    return NextResponse.json({ received: true }, { status: 200 });
  }

  /*
   * Transfer events settle a withdrawal.
   *
   * These used to fall through to the "not an event we act on" branch below,
   * which meant a payout could be submitted and never settled: the customer's
   * money sat in PROCESSING indefinitely, neither paid nor returned. Handling
   * them is what makes the withdrawal state machine terminate.
   */
  const eventName = typeof payload.event === "string" ? payload.event : "";
  if (eventName.startsWith("transfer.")) {
    return handleTransferEvent(payload);
  }

  const event = toDepositEvent(payload);
  if (!event) {
    // Authentic, but not an event we act on (disputes, customer updates, ...).
    return NextResponse.json({ received: true }, { status: 200 });
  }

  try {
    const result = await depositService.applyDepositWebhook(PROVIDER, event);
    return NextResponse.json({ received: true, duplicate: result.duplicate }, { status: 200 });
  } catch (error) {
    if (error instanceof UnattributableDepositError) {
      // Acknowledged on purpose: we cannot say whose money this is, and no
      // number of retries will tell us. The intent is not created, so nothing
      // is credited, and it surfaces for support rather than looping forever.
      console.error("[paystack] unattributable deposit", { providerRef: event.providerRef });
      return NextResponse.json({ received: true, attributed: false }, { status: 200 });
    }
    // A real failure — database down, ledger constraint violated. Return 5xx
    // so Paystack retries; the deposit path is idempotent, so a retry is safe.
    console.error("[paystack] webhook failed", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}

/**
 * Settles a withdrawal from a transfer webhook.
 *
 * PROCESSING updates are acknowledged and ignored — Paystack emits several on
 * the way to a terminal state, and acting on each would be noise. Only
 * success and failure change anything.
 *
 * `reconcile` is idempotent: PAID is terminal and the database trigger refuses
 * a second transition into it, so a replayed webhook cannot pay twice.
 */
async function handleTransferEvent(payload: Record<string, unknown>): Promise<NextResponse> {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const eventName = typeof payload.event === "string" ? payload.event : "";
  const status = typeof data.status === "string" ? data.status : "";

  // Our withdrawal id, echoed back as the reference we set when transferring.
  const withdrawalId = String(data.reference ?? "");
  if (!UUID_PATTERN.test(withdrawalId)) {
    console.error("[paystack] transfer event with unrecognised reference", { withdrawalId });
    // Acknowledged: retrying will not make the reference recognisable.
    return NextResponse.json({ received: true, matched: false }, { status: 200 });
  }

  const outcome = mapTransferStatus(status);
  if (outcome === "PROCESSING") {
    return NextResponse.json({ received: true, settled: false }, { status: 200 });
  }

  try {
    const result = await withdrawalService.reconcile(withdrawalId, {
      status: outcome,
      failureReason:
        outcome === "FAILED"
          ? // A reversal is money that left and came back — the bank accepted
            // then rejected it. Worth distinguishing in the record from a
            // transfer that never left.
            eventName === "transfer.reversed"
            ? "reversed by the receiving bank"
            : (typeof data.reason === "string" ? data.reason : "transfer failed").slice(0, 300)
          : undefined,
    });
    return NextResponse.json({ received: true, duplicate: result.duplicate }, { status: 200 });
  } catch (error) {
    console.error("[paystack] transfer settlement failed", { withdrawalId, error });
    // 5xx so Paystack retries. Settlement is idempotent, so a retry is safe —
    // and leaving a payout unsettled is worse than a duplicate delivery.
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}

/**
 * Narrows a Paystack payload to the deposit events we act on.
 *
 * Field names follow Paystack's documented `charge.success` shape. They have
 * not been checked against live traffic — treat this the same way as the odds
 * adapter until a real webhook has been captured.
 */
function toDepositEvent(payload: Record<string, unknown>): DepositWebhookEvent | null {
  const eventName = typeof payload.event === "string" ? payload.event : "";
  if (!eventName.startsWith("charge.")) return null;

  const data = (payload.data ?? {}) as Record<string, unknown>;
  const reference = typeof data.reference === "string" ? data.reference : null;
  const amount = data.amount;
  if (!reference || typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    return null;
  }

  const status = typeof data.status === "string" ? data.status : "";
  const authorization = (data.authorization ?? {}) as Record<string, unknown>;
  const customer = (data.customer ?? {}) as Record<string, unknown>;

  return {
    providerRef: reference,
    // Paystack amounts are already in kobo — the minor unit — so this is a
    // widening to BigInt, not a conversion. Multiplying here would inflate
    // every deposit a hundredfold.
    amountMinor: BigInt(amount),
    status: eventName === "charge.success" && status === "success" ? "SUCCEEDED"
      : status === "failed" ? "FAILED"
      : "PENDING",
    virtualAccountRef:
      typeof authorization.receiver_bank_account_number === "string"
        ? authorization.receiver_bank_account_number
        : undefined,
    customerRef: typeof customer.metadata === "object" && customer.metadata !== null
      ? ((customer.metadata as Record<string, unknown>).userId as string | undefined)
      : undefined,
    raw: payload,
  };
}
