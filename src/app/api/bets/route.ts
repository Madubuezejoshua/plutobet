import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { placementService } from "@/modules/betting/placement.service";
import { walletForUser } from "@/modules/wallet/lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const placeSchema = z.object({
  // Money arrives as a STRING and is parsed to BigInt. A JSON number loses
  // precision above 2^53 and, worse, accepts 100.5 kobo — which is not a
  // quantity of money that exists.
  stakeMinor: z
    .string()
    .regex(/^\d+$/, "stake must be a whole number of kobo")
    .transform((value) => BigInt(value)),
  legs: z
    .array(
      z.object({
        selectionId: z.string().uuid(),
        // The price the user was SHOWN. Placement compares it against the
        // live price and applies the drift policy — this is what makes
        // "bet accepted at odds the user didn't see" impossible.
        odds: z.string().regex(/^\d+(\.\d{1,3})?$/, "odds must be decimal with up to 3 places"),
      }),
    )
    .min(1, "a slip needs at least one selection")
    .max(20, "too many legs on one slip"),
  /** Stable per-slip key from the client; a double-tapped submit replays. */
  idempotencyKey: z.string().min(8).max(200),
});

/** Places a single or accumulator. */
export const POST = authedRoute(
  "placeBet",
  RATE_RULES.placeBet,
  async ({ request, userId, ip }: AuthedRouteContext) => {
    const body = placeSchema.parse(await request.json());

    const walletId = await walletForUser(userId);
    if (!walletId) throw new ApiError(409, "NO_WALLET", "this account has no NGN wallet");

    const placed = await placementService.placeBet({
      userId,
      walletId,
      ip,
      stakeMinor: body.stakeMinor,
      legs: body.legs,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(
      {
        betId: placed.betId,
        stakeMinor: money(placed.stakeMinor),
        totalOddsDecimal: placed.totalOddsDecimal,
        potentialReturnMinor: money(placed.potentialReturnMinor),
        balanceAfterMinor: money(placed.balanceAfterMinor),
      },
      { status: 201 },
    );
  },
);
