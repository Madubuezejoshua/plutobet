import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import {
  DateOfBirthAlreadySetError,
  dateOfBirthService,
} from "@/modules/users/date-of-birth.service";
import { InvalidDateOfBirthError, UnderageError } from "@/modules/users/age";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Supplying a date of birth that was never recorded.
 *
 * Write-once. There is no PUT and no way to change a date already on file: the
 * age gate rests on this value, and an editable one would turn a refused
 * registration into an accepted one on the second attempt. Correcting a genuine
 * mistake is an admin action with a reason attached.
 *
 * Rate-limited on the `kyc` budget rather than a generous one. It is submitted
 * once in an account's life, and the only reason to call it repeatedly is to
 * probe the age boundary.
 */

const schema = z
  .object({
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "enter your date of birth as YYYY-MM-DD"),
  })
  .strict();

export const POST = authedRoute(
  "kyc",
  RATE_RULES.kyc,
  async ({ request, userId, ip }: AuthedRouteContext) => {
    const body = schema.parse(await request.json());

    try {
      await dateOfBirthService.complete({ userId, dateOfBirth: body.dateOfBirth, ip });
    } catch (error) {
      /*
       * Underage is 403, not 422.
       *
       * The request was well formed and the answer was understood; the account
       * holder is not permitted. Reporting it as a validation error would invite
       * the interface to say "check the date" to someone who typed it correctly.
       */
      if (error instanceof UnderageError) {
        throw new ApiError(403, "UNDERAGE", error.message);
      }
      if (error instanceof InvalidDateOfBirthError) {
        throw new ApiError(422, "INVALID_DATE_OF_BIRTH", error.message);
      }
      if (error instanceof DateOfBirthAlreadySetError) {
        throw new ApiError(409, "ALREADY_SET", error.message);
      }
      throw error;
    }

    /*
     * The date is NOT echoed back. The client already has what it sent, and a
     * response body carrying a date of birth is one more place it can be logged
     * by a proxy that logs response bodies.
     */
    return NextResponse.json({ completed: true });
  },
);
