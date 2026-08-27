import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { placementService } from "@/modules/betting/placement.service";
import { walletForUser } from "@/modules/wallet/lookup";
import { profileService, type OddsChangePolicy } from "@/modules/users/profile.service";
import type { OddsDriftPolicy } from "@/modules/betting/placement.service";

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

    /*
     * The odds-change policy is read from the account's stored preference on
     * the SERVER. It is deliberately absent from the request schema: a client
     * that could name its own policy could send "accept anything" and have a
     * drifted price accepted on the customer's behalf, which harms them and
     * which they never agreed to.
     *
     * A failure to read preferences falls back to the strictest behaviour
     * (reject on any drift) rather than the most permissive.
     */
    const preferences = await profileService
      .preferences(userId)
      .catch(() => null);

    const placed = await placementService.placeBet({
      userId,
      walletId,
      ip,
      stakeMinor: body.stakeMinor,
      legs: body.legs,
      idempotencyKey: body.idempotencyKey,
      driftPolicy: toDriftPolicy(preferences?.oddsChangePolicy),
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

/**
 * Customer-facing preference to the engine's policy.
 *
 * "ASK" maps to REJECT: the server refuses, the client shows both prices, and
 * the customer decides. There is no server-side "ask" — asking is what a
 * rejection MEANS at this boundary.
 *
 * Anything unrecognised, including a missing preference, resolves to the
 * strictest option. Failing safe here means the customer is asked, not that a
 * worse price is taken silently.
 */
function toDriftPolicy(policy: OddsChangePolicy | undefined): OddsDriftPolicy {
  switch (policy) {
    case "ANY":
      return "ACCEPT_ANY";
    case "HIGHER_ONLY":
      return "ACCEPT_IF_BETTER";
    case "ASK":
    default:
      return "REJECT";
  }
}
