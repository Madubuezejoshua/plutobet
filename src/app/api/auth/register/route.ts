import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { createOtpService, OtpError } from "@/modules/notifications/otp.service";
import { InvalidPhoneNumberError } from "@/modules/notifications/phone";
import { RegistrationError, registrationService } from "@/modules/users/registration.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200),
  phoneNumber: z.string().min(7).max(20),
  /** The code sent to that number. */
  otp: z.string().regex(/^\d{6}$/, "enter the 6-digit code"),
});

/**
 * Creates an account.
 *
 * The OTP is verified FIRST and separately from account creation. Verifying
 * inside the registration transaction would roll the code's attempt counter
 * back on any later failure — the exact bug that made the attempt cap
 * useless in the OTP service, and it would reappear here.
 *
 * The cost of that ordering is a consumed code with no account when
 * registration then fails (a taken email, say). That is the right trade: the
 * user requests a fresh code, and the alternative silently disarms the
 * brute-force protection.
 */
export const POST = publicRoute(
  "register",
  RATE_RULES.register,
  async ({ request, ip }: RouteContext) => {
    const body = registerSchema.parse(await request.json());

    try {
      await createOtpService().verify({
        destination: body.phoneNumber,
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        code: body.otp,
      });
    } catch (error) {
      if (error instanceof OtpError) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 403 });
      }
      if (error instanceof InvalidPhoneNumberError) {
        return NextResponse.json(
          { error: "INVALID_PHONE", message: "enter a valid Nigerian mobile number" },
          { status: 422 },
        );
      }
      throw error;
    }

    try {
      const created = await registrationService.register({
        email: body.email,
        password: body.password,
        phoneNumber: body.phoneNumber,
        phoneVerified: true,
      });

      // No session is issued here. The client signs in through the normal
      // credentials flow, so there is exactly one code path that mints a
      // session — and therefore one place where suspension and
      // self-exclusion are checked.
      return NextResponse.json({ userId: created.userId }, { status: 201 });
    } catch (error) {
      if (error instanceof RegistrationError) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
      }
      if (error instanceof InvalidPhoneNumberError) {
        return NextResponse.json(
          { error: "INVALID_PHONE", message: "enter a valid Nigerian mobile number" },
          { status: 422 },
        );
      }
      throw error;
    }
  },
);
