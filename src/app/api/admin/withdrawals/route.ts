import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/api/handler";
import { rateLimiter, RATE_RULES } from "@/lib/api/rate-limit";
import {
  AdminRequiredError,
  PermissionDeniedError,
  ReauthRequiredError,
  requireSensitivePermission,
} from "@/modules/admin/guard";
import { reauthService } from "@/modules/admin/reauth.service";
import { withdrawalService } from "@/modules/payments/withdrawal.service";
import { WithdrawalRejectedError } from "@/modules/payments/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  withdrawalId: z.string().uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
  /** Mandatory. The audit row and the customer-facing reason both need it. */
  reason: z.string().min(3).max(500),
});

/**
 * Approves or rejects a withdrawal.
 *
 * Requires `withdrawals.review`, which is a step-up permission: approving a
 * payout is one of the few actions where an unlocked laptop must not be
 * enough. The proof is held server-side (see admin/reauth.service.ts) and is
 * never accepted from the request.
 *
 * Approving does NOT send the money. It moves the row to APPROVED, and the
 * payout worker picks it up. That separation is deliberate: a bank transfer
 * inside this request would hold a row lock across a slow third-party call and
 * leave the outcome ambiguous on timeout.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = clientIp(request);

  try {
    const body = bodySchema.parse(await request.json());
    const identity = await requireSensitivePermission("withdrawals.review");

    const outcome = await rateLimiter.consume(
      "admin-withdrawals",
      identity.userId,
      RATE_RULES.withdrawal,
    );
    if (!outcome.allowed) {
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    }

    /*
     * `reauthenticatedAt` is stamped here, not taken from the request.
     *
     * That is only honest because `requireSensitivePermission` above has
     * already checked the server-held step-up proof for this session. This
     * timestamp therefore records a re-authentication the server itself just
     * verified, and carries that verified fact into the wallet service's own
     * staleness guard. Accepting it from the caller — as an earlier draft of
     * the roles endpoint did — would make it worthless.
     */
    const admin = {
      type: "ADMIN" as const,
      id: identity.userId,
      ip,
      reason: body.reason,
      reauthenticatedAt: new Date(),
    };

    if (body.decision === "APPROVE") {
      await withdrawalService.approve(body.withdrawalId, admin);
    } else {
      // Rejecting returns the held funds to the customer's balance.
      await withdrawalService.reject(body.withdrawalId, admin);
    }

    // One password entry authorises one decision, not five minutes of
    // unattended access to the payout queue.
    await reauthService.consume(identity.userId, identity.sessionId);

    return NextResponse.json({ decision: body.decision });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "INVALID_REQUEST", issues: error.issues.map((i) => i.message) },
        { status: 422 },
      );
    }
    if (error instanceof AdminRequiredError) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
    if (error instanceof ReauthRequiredError) {
      return NextResponse.json(
        { error: "REAUTH_REQUIRED", message: "Confirm your password to continue." },
        { status: 401 },
      );
    }
    if (error instanceof PermissionDeniedError) {
      return NextResponse.json({ error: "FORBIDDEN", message: error.message }, { status: 403 });
    }
    if (error instanceof WithdrawalRejectedError) {
      return NextResponse.json({ error: error.name, message: error.message }, { status: 409 });
    }

    console.error("[api] withdrawal review failed", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
