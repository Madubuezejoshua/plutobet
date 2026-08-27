import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { OtpError } from "@/modules/notifications/otp.service";
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

    let devCode: string | undefined;
    try {
      ({ devCode } = await passwordResetService.request({ email: body.email, ip }));
    } catch (error) {
      // Even a rate-limit refusal is not echoed differently, for the same
      // reason: "you are being throttled" confirms the address is real.
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
