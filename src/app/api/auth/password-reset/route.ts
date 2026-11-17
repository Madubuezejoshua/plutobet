import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import {
  OtpError,
  OtpProviderUnavailableError,
  otpDeliveryAvailable,
} from "@/modules/notifications/otp.service";
import {
  PasswordResetError,
  passwordResetService,
} from "@/modules/users/password-reset.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({ email: z.string().email().max(254) });

const resetSchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/, "enter the 6-digit code"),
  newPassword: z.string().min(10).max(200),
});

/**
 * Step 1 — ask for a code.
 *
 * ALWAYS reports the same thing, whether or not the address has an account.
 * A reset form that distinguishes them is a free membership oracle for a
 * gambling site, which is a privacy problem before it is a security one.
 */
export const POST = publicRoute(
  "password-reset",
  RATE_RULES.otp,
  async ({ request, ip }: RouteContext) => {
    const body = requestSchema.parse(await request.json());

    /*
     * DELIVERY FIRST, ADDRESS SECOND. The order is the security property.
     *
     * `otpDeliveryAvailable` depends only on configuration, so this answers the
     * same way for every address. Asking it before the lookup is what keeps the
     * two paths indistinguishable.
     *
     * This endpoint used to answer **500 for an address with an account and 200
     * for one without**, whenever it ran in production with no email provider —
     * which is the state it is deployed in. An unknown address short-circuits
     * before any provider is touched and returned the cheerful 200 below; a
     * real one reached the OTP service, hit its refusal to use the console
     * fallback in production, and threw past the `OtpError` catch as a 500.
     * The difference is a free membership oracle for a gambling site, and it is
     * a privacy problem before it is a security one.
     *
     * 503 rather than a false 200: with no provider, "a reset code is on its
     * way" is untrue for everybody, and saying it anyway would trade an oracle
     * for a lie.
     */
    if (!otpDeliveryAvailable("EMAIL")) {
      return NextResponse.json(
        {
          error: "DELIVERY_UNAVAILABLE",
          message:
            "Password reset is unavailable right now. No email provider is configured for this deployment.",
        },
        { status: 503 },
      );
    }

    let devCode: string | undefined;
    try {
      ({ devCode } = await passwordResetService.request({ email: body.email, ip }));
    } catch (error) {
      // Even a rate-limit refusal is not echoed differently, for the same
      // reason: "you are being throttled" confirms the address is real.
      if (error instanceof OtpProviderUnavailableError) {
        // Configuration changed under us between the check and the send. Still
        // must not vary by address.
        return NextResponse.json(
          { error: "DELIVERY_UNAVAILABLE", message: "Password reset is unavailable right now." },
          { status: 503 },
        );
      }
      if (!(error instanceof OtpError)) throw error;
    }

    return NextResponse.json({
      sent: true,
      message: "If that address has an account, a reset code is on its way.",
      ...(devCode ? { devCode } : {}),
    });
  },
);

/** Step 2 — supply the code and the new password. */
export const PUT = publicRoute(
  "password-reset",
  RATE_RULES.otp,
  async ({ request }: RouteContext) => {
    const body = resetSchema.parse(await request.json());

    try {
      await passwordResetService.reset({
        email: body.email,
        code: body.code,
        newPassword: body.newPassword,
      });
    } catch (error) {
      if (error instanceof PasswordResetError) {
        return NextResponse.json(
          { error: error.code, message: error.message },
          { status: error.code === "WEAK_PASSWORD" ? 422 : 403 },
        );
      }
      throw error;
    }

    return NextResponse.json({ reset: true, allSessionsSignedOut: true });
  },
);
