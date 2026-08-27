import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { authOptions } from "@/modules/auth/auth-options";
import { ProfileError, profileService } from "@/modules/users/profile.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});

/**
 * Changes the account password.
 *
 * Rate limited on the `otp` rule rather than the general wallet one: this
 * endpoint verifies a password, which makes it an oracle for guessing one if
 * it is allowed to be called freely.
 */
export const POST = authedRoute(
  "account-password",
  RATE_RULES.otp,
  async ({ request, userId }: AuthedRouteContext) => {
    const body = bodySchema.parse(await request.json());
    const session = await getServerSession(authOptions);

    try {
      await profileService.changePassword({
        userId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        // Everything else is signed out; the device doing the change is not.
        keepSessionId: session?.user.sessionId ?? undefined,
      });
    } catch (error) {
      if (error instanceof ProfileError) {
        return NextResponse.json(
          { error: error.code, message: error.message },
          { status: error.code === "WRONG_PASSWORD" ? 403 : 422 },
        );
      }
      throw error;
    }

    return NextResponse.json({ changed: true, otherSessionsSignedOut: true });
  },
);
