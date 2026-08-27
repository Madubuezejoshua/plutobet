import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { clientIp } from "@/lib/api/handler";
import { rateLimiter, RATE_RULES } from "@/lib/api/rate-limit";
import { authOptions } from "@/modules/auth/auth-options";
import { AdminRequiredError, requireAdminIdentity } from "@/modules/admin/guard";
import { ReauthError, reauthService } from "@/modules/admin/reauth.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ password: z.string().min(1).max(200) });

/**
 * Opens a five-minute step-up window for the calling session.
 *
 * Rate limited on the `otp` budget rather than the admin one: this endpoint
 * verifies a password, which makes it an oracle for guessing one.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = bodySchema.parse(await request.json());
    const identity = await requireAdminIdentity();
    const session = await getServerSession(authOptions);

    const outcome = await rateLimiter.consume("admin-reauth", identity.userId, RATE_RULES.otp);
    if (!outcome.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED" },
        { status: 429, headers: { "retry-after": String(outcome.retryAfterSeconds) } },
      );
    }

    const { expiresAt } = await reauthService.confirm({
      userId: identity.userId,
      sessionId: session?.user.sessionId ?? null,
      password: body.password,
    });

    return NextResponse.json({ confirmed: true, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 422 });
    }
    if (error instanceof AdminRequiredError) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
    if (error instanceof ReauthError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.code === "WRONG_PASSWORD" ? 403 : 409 },
      );
    }

    console.error("[api] admin reauth error", error, clientIp(request));
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
