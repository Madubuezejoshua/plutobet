import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { authOptions } from "@/modules/auth/auth-options";
import { describeDevice, sessionService } from "@/modules/users/session.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const revokeSchema = z.union([
  z.object({ sessionId: z.string().uuid() }),
  z.object({ all: z.literal(true) }),
]);

export const GET = authedRoute(
  "wallet",
  RATE_RULES.wallet,
  async ({ userId }: AuthedRouteContext) => {
    const session = await getServerSession(authOptions);
    const sessions = await sessionService.list(userId, session?.user.sessionId ?? undefined);

    return NextResponse.json({
      sessions: sessions.map((entry) => ({
        id: entry.id,
        device: describeDevice(entry.userAgent),
        // The address is shown to the account holder as their own security
        // information — it is not exposed anywhere else.
        ip: entry.ip,
        createdAt: entry.createdAt.toISOString(),
        lastSeenAt: entry.lastSeenAt.toISOString(),
        revokedAt: entry.revokedAt?.toISOString() ?? null,
        revokedReason: entry.revokedReason,
        current: entry.current,
      })),
    });
  },
);

/**
 * Signs out a device, or every other device.
 *
 * The caller's own session is preserved in the `all` case: signing yourself
 * out while trying to evict an intruder is a poor outcome, and the sign-out
 * button already exists for that.
 */
export const DELETE = authedRoute(
  "wallet",
  RATE_RULES.wallet,
  async ({ request, userId }: AuthedRouteContext) => {
    const body = revokeSchema.parse(await request.json());
    const session = await getServerSession(authOptions);

    if ("all" in body) {
      const revoked = await sessionService.revokeAll({
        userId,
        exceptSessionId: session?.user.sessionId ?? undefined,
      });
      return NextResponse.json({ revoked });
    }

    // Ownership is enforced inside the UPDATE, so someone else's session id
    // simply matches nothing rather than leaking whether it exists.
    const revoked = await sessionService.revoke({ userId, sessionId: body.sessionId });
    return NextResponse.json({ revoked: revoked ? 1 : 0 });
  },
);
