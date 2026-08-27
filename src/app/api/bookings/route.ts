import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { authOptions } from "@/modules/auth/auth-options";
import { BookingCodeError, bookingService } from "@/modules/betting/booking.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const saveSchema = z.object({
  selectionIds: z.array(z.string().uuid()).min(1).max(20),
});

function toStatus(error: BookingCodeError): number {
  switch (error.code) {
    case "NOT_FOUND":
      return 404;
    case "EXPIRED":
      return 410; // Gone: it existed and no longer does.
    default:
      return 422;
  }
}

/**
 * Saves a slip and returns a shareable code.
 *
 * Public: a code can be built without an account, because sharing a slip is
 * how people arrive. The author is recorded when there is a session.
 */
export const POST = publicRoute(
  "browse",
  RATE_RULES.browse,
  async ({ request }: RouteContext) => {
    const body = saveSchema.parse(await request.json());
    const session = await getServerSession(authOptions);

    try {
      const result = await bookingService.save({
        userId: session?.user.id ?? null,
        selectionIds: body.selectionIds,
      });
      return NextResponse.json(
        { code: result.code, expiresAt: result.expiresAt.toISOString() },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof BookingCodeError) {
        return NextResponse.json(
          { error: error.code, message: error.message },
          { status: toStatus(error) },
        );
      }
      throw error;
    }
  },
);

/**
 * Loads a code.
 *
 * Returns SELECTIONS at today's prices — never a bet, never a stake. The
 * loader did not build this slip and has agreed to nothing; they confirm their
 * own wager with their own money.
 */
export const GET = publicRoute(
  "browse",
  RATE_RULES.browse,
  async ({ request }: RouteContext) => {
    const code = new URL(request.url).searchParams.get("code") ?? "";

    try {
      const loaded = await bookingService.load(code);
      return NextResponse.json({
        code: loaded.code,
        createdAt: loaded.createdAt.toISOString(),
        hasUnavailable: loaded.hasUnavailable,
        selections: loaded.selections,
      });
    } catch (error) {
      if (error instanceof BookingCodeError) {
        return NextResponse.json(
          { error: error.code, message: error.message },
          { status: toStatus(error) },
        );
      }
      throw error;
    }
  },
);
