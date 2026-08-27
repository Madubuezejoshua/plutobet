import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { rateLimiter } from "@/lib/api/rate-limit";
import {
  AdminRequiredError,
  PermissionDeniedError,
  ReauthRequiredError,
  requireSensitivePermission,
} from "@/modules/admin/guard";
import { ADMIN_ROLES } from "@/modules/admin/permissions";
import { RbacError, rbacService } from "@/modules/admin/rbac.service";
import { reauthService } from "@/modules/admin/reauth.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["GRANT", "REVOKE"]),
  targetUserId: z.string().uuid(),
  role: z.enum(ADMIN_ROLES),
  /** Mandatory. The audit row is worthless without it. */
  reason: z.string().min(3).max(500),
});

/*
 * Note there is no `reauthenticatedAt` field. Step-up proof is held by the
 * server (see modules/admin/reauth.service.ts) and is never accepted from the
 * request — a timestamp the caller chooses is not evidence of anything.
 */

/**
 * Grants and revokes admin roles.
 *
 * Hand-rolled rather than using `adminRoute`, because this endpoint needs the
 * step-up check and its own error vocabulary. Everything else about it follows
 * the same shape: rate limit, authorise, act, map typed errors to statuses.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = clientIp(request);

  try {
    const body = bodySchema.parse(await request.json());

    const identity = await requireSensitivePermission("admin.roles.manage");

    const outcome = await rateLimiter.consume("admin-roles", identity.userId, RATE_RULES.admin);
    if (!outcome.allowed) {
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    }

    if (body.action === "GRANT") {
      const { grantId } = await rbacService.grant({
        actorUserId: identity.userId,
        targetUserId: body.targetUserId,
        role: body.role,
        reason: body.reason,
        ip,
      });
      // One password entry authorises one change, not five minutes of
      // unattended access to the role system.
      await reauthService.consume(identity.userId, identity.sessionId);
      return NextResponse.json({ granted: true, grantId });
    }

    await rbacService.revoke({
      actorUserId: identity.userId,
      targetUserId: body.targetUserId,
      role: body.role,
      reason: body.reason,
      ip,
    });
    await reauthService.consume(identity.userId, identity.sessionId);
    return NextResponse.json({ revoked: true });
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
    if (error instanceof RbacError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.code === "NOT_PERMITTED" ? 403 : 409 },
      );
    }
    if (error instanceof RangeError) {
      return NextResponse.json({ error: "INVALID_REQUEST", message: error.message }, { status: 422 });
    }

    console.error("[api] admin roles error", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
