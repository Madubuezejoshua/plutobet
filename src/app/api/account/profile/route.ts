import { NextResponse } from "next/server";
import { z } from "zod";
import { authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { ProfileError, profileService } from "@/modules/users/profile.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Non-sensitive profile fields only.
 *
 * Email, phone and password each have their own endpoint because each needs
 * its own proof of identity. Date of birth is absent by design: it is an
 * eligibility fact the age gate rests on, not a preference, so correcting it
 * is a support action with an audit trail rather than a form field.
 */
const bodySchema = z.object({
  firstName: z.string().min(1).max(80).nullable().optional(),
  lastName: z.string().min(1).max(80).nullable().optional(),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_]{3,20}$/, "3-20 letters, numbers or underscore")
    .nullable()
    .optional(),
});

export const GET = authedRoute(
  "wallet",
  RATE_RULES.wallet,
  async ({ userId }: AuthedRouteContext) => {
    const profile = await profileService.get(userId);
    return NextResponse.json(profile);
  },
);

export const PATCH = authedRoute(
  "wallet",
  RATE_RULES.wallet,
  async ({ request, userId }: AuthedRouteContext) => {
    const body = bodySchema.parse(await request.json());

    try {
      await profileService.updateProfile({ userId, ...body });
    } catch (error) {
      if (error instanceof ProfileError) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json(await profileService.get(userId));
  },
);
