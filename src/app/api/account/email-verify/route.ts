import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { db } from "@/db/pooled";
import { createOtpService, OtpError } from "@/modules/notifications/otp.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email verification.
 *
 * The OTP service and the `EMAIL_VERIFY` purpose already existed; what was
 * missing was any way for a customer to actually reach them, so
 * `email_verified_at` stayed null for every account ever created.
 *
 * AUTHENTICATED, unlike the phone OTP route. That endpoint has to be public
 * because it runs before an account exists. This one does not, and keeping it
 * behind a session removes the abuse surface entirely: the address is read
 * from the session rather than the request, so it cannot be pointed at a
 * stranger's inbox.
 */

const confirmSchema = z.object({
  code: z.string().trim().min(4).max(10),
});

async function currentEmail(userId: string): Promise<{ email: string; verified: boolean } | null> {
  const [row] = await db.execute<{ email: string; email_verified_at: Date | null }>(sql`
    SELECT email, email_verified_at FROM users WHERE id = ${userId}::uuid
  `);
  if (!row) return null;
  return { email: row.email, verified: row.email_verified_at !== null };
}

/** Sends a fresh code to the address on the account. */
export const POST = authedRoute(
  "emailVerifyIssue",
  RATE_RULES.otp,
  async ({ userId, ip }: AuthedRouteContext) => {
    const account = await currentEmail(userId);
    if (!account) {
      return NextResponse.json({ error: "NO_ACCOUNT" }, { status: 404 });
    }
    if (account.verified) {
      // Not an error. Re-sending to an address already verified would spend a
      // send and invite a support ticket about a code that does nothing.
      return NextResponse.json({ alreadyVerified: true });
    }

    try {
      const issued = await createOtpService().issue({
        destination: account.email,
        channel: "EMAIL",
        purpose: "EMAIL_VERIFY",
        userId,
        ip,
      });

      return NextResponse.json({
        sent: true,
        expiresAt: issued.expiresAt.toISOString(),
        // Present only when no email provider is configured, so the flow can
        // be completed locally. Never returned in production.
        ...(issued.devCode ? { devCode: issued.devCode } : {}),
      });
    } catch (error) {
      if (error instanceof OtpError) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 429 });
      }
      throw error;
    }
  },
);

/** Confirms a code and marks the address verified. */
export const PUT = authedRoute(
  "emailVerifyConfirm",
  RATE_RULES.otp,
  async ({ request, userId }: AuthedRouteContext) => {
    const body = confirmSchema.parse(await request.json());

    const account = await currentEmail(userId);
    if (!account) {
      return NextResponse.json({ error: "NO_ACCOUNT" }, { status: 404 });
    }
    if (account.verified) return NextResponse.json({ verified: true });

    try {
      await createOtpService().verify({
        destination: account.email,
        channel: "EMAIL",
        purpose: "EMAIL_VERIFY",
        code: body.code,
      });
    } catch (error) {
      if (error instanceof OtpError) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
      }
      throw error;
    }

    /*
     * Only stamp a row that is still unverified.
     *
     * Two codes racing would otherwise move the timestamp forward on an
     * already-verified account, rewriting when verification happened. The
     * WHERE clause makes the second one a no-op rather than a correction.
     */
    await db.execute(sql`
      UPDATE users
      SET email_verified_at = now(), updated_at = now()
      WHERE id = ${userId}::uuid AND email_verified_at IS NULL
    `);

    return NextResponse.json({ verified: true });
  },
);
