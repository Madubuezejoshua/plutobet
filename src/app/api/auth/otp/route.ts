import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { createOtpService, OtpError } from "@/modules/notifications/otp.service";
import { InvalidPhoneNumberError } from "@/modules/notifications/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const issueSchema = z.object({
  phoneNumber: z.string().min(7).max(20),
  purpose: z.enum(["PHONE_VERIFY", "PASSWORD_RESET"]),
});

/**
 * Sends a verification code.
 *
 * Public by necessity — it runs before an account exists — which makes it the
 * most abusable endpoint on the platform: every call costs money in SMS fees
 * and lands on somebody's real phone. The service applies its own
 * per-destination and per-IP throttles on top of the route limiter here.
 *
 * The response is deliberately uninformative about whether the number is
 * already registered. Saying so turns this into a free tool for checking
 * which phone numbers hold betting accounts.
 */
export const POST = publicRoute(
  "otpIssue",
  RATE_RULES.otp,
  async ({ request, ip }: RouteContext) => {
    const body = issueSchema.parse(await request.json());

    try {
      const issued = await createOtpService().issue({
        destination: body.phoneNumber,
        channel: "SMS",
        purpose: body.purpose,
        ip,
      });

      return NextResponse.json({
        sent: true,
        expiresAt: issued.expiresAt.toISOString(),
        // Present only when no SMS provider is configured, so local
        // development can complete the flow. Never returned in production.
        ...(issued.devCode ? { devCode: issued.devCode } : {}),
      });
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        return NextResponse.json(
          { error: "INVALID_PHONE", message: "enter a valid Nigerian mobile number" },
          { status: 422 },
        );
      }
      if (error instanceof OtpError) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 429 });
      }
      throw error;
    }
  },
);
