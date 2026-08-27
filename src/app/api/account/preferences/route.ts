import { NextResponse } from "next/server";
import { z } from "zod";
import { authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { profileService } from "@/modules/users/profile.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  oddsFormat: z.enum(["DECIMAL", "FRACTIONAL", "AMERICAN"]).optional(),
  oddsChangePolicy: z.enum(["ASK", "HIGHER_ONLY", "ANY"]).optional(),
  emailNotifications: z.boolean().optional(),
  smsNotifications: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
  timezone: z.string().max(64).optional(),
});

export const GET = authedRoute(
  "wallet",
  RATE_RULES.wallet,
  async ({ userId }: AuthedRouteContext) => {
    return NextResponse.json(await profileService.preferences(userId));
  },
);

export const PATCH = authedRoute(
  "wallet",
  RATE_RULES.wallet,
  async ({ request, userId }: AuthedRouteContext) => {
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(await profileService.updatePreferences(userId, body));
  },
);
