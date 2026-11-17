import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { createOtpService, OtpError } from "@/modules/notifications/otp.service";
import { InvalidPhoneNumberError } from "@/modules/notifications/phone";
import { RegistrationError, registrationService } from "@/modules/users/registration.service";
import { InvalidDateOfBirthError, UnderageError } from "@/modules/users/age";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200),
  phoneNumber: z.string().min(7).max(20),
  /** The code sent to that number. */
  otp: z.string().regex(/^\d{6}$/, "enter the 6-digit code"),
  /** Required: an account whose age is unproven cannot legally bet. */
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "enter your date of birth"),
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_]{3,20}$/, "3-20 letters, numbers or underscore")
    .optional(),
  country: z.string().length(2).optional(),
  referredByCode: z.string().max(20).optional(),
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
  async ({ request }: RouteContext) => {
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
        dateOfBirth: body.dateOfBirth,
        firstName: body.firstName,
        lastName: body.lastName,
        username: body.username,
        country: body.country,
        referredByCode: body.referredByCode,
        phoneVerified: true,
      });

      // No session is issued here. The client signs in through the normal
      // credentials flow, so there is exactly one code path that mints a
      // session — and therefore one place where suspension and
      // self-exclusion are checked.
      return NextResponse.json(
        { userId: created.userId, referralCode: created.referralCode },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof RegistrationError) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
      }
      // 403, not 422: this is a refusal to serve, not a formatting complaint.
      // The message is deliberately plain — someone underage should be told
      // clearly, not shown a validation error they might try to work around.
      if (error instanceof UnderageError) {
        return NextResponse.json({ error: "UNDERAGE", message: error.message }, { status: 403 });
      }
      if (error instanceof InvalidDateOfBirthError) {
        return NextResponse.json(
          { error: "INVALID_DOB", message: error.message },
          { status: 422 },
        );
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
