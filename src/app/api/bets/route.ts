import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { SlipError, slipService } from "@/modules/betting/slip.service";
import { StakeLimitError } from "@/modules/betting/errors";
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
    .transform((value) => BigInt(value))
    // `^\d+$` accepts "0", which then travelled all the way to the database
    // and was refused by `bet_slips_unit_stake_positive` — correct, but it
    // surfaced as a 500. The constraint is the last line of defence, not the
    // first: a stake of zero is a form error and belongs to the boundary.
    .refine((value) => value > 0n, "stake must be greater than zero"),
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

  /*
   * System bets. Both optional, so an ordinary single or accumulator posts
   * exactly the body it always did.
   *
   * `stakeMinor` is the stake PER COMBINATION when a system is requested. A
   * "100 naira 2/3" therefore costs 300 naira, and the response says so
   * explicitly rather than leaving the customer to work it out.
   */
  systemSize: z.number().int().min(1).max(20).optional(),
  bankerIndices: z.array(z.number().int().min(0).max(19)).max(19).optional(),
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

    let slip;
    try {
      slip = await slipService.placeSlip({
        userId,
        walletId,
        ip,
        legs: body.legs,
        unitStakeMinor: body.stakeMinor,
        systemSize: body.systemSize,
        bankerIndices: body.bankerIndices,
        idempotencyKey: body.idempotencyKey,
        driftPolicy: toDriftPolicy(preferences?.oddsChangePolicy),
      });
    } catch (error) {
      if (error instanceof SlipError) {
        /*
         * The per-combination reasons travel with the response.
         *
         * They were dropped here, so a customer with an empty wallet was told
         * "none of the combinations on this slip could be placed" — accurate,
         * useless, and indistinguishable from a suspended market or a price
         * that moved. On a single bet there is exactly one reason and the
         * service already knows it.
         *
         * They are the curated pair from `customerReason`, never the raw
         * domain message, which carries wallet ids and the book's remaining
         * appetite on a market.
         */
        throw new ApiError(
          error.code === "INVALID_SLIP" ? 422 : 409,
          error.code,
          error.message,
          error.failures.length > 0 ? error.failures : undefined,
        );
      }
      /*
       * A stake outside the permitted range is the CLIENT's mistake.
       *
       * This was unmapped, so posting a stake of 0 — which the schema's
       * `^\d+$` happily accepts — reached the service, threw StakeLimitError,
       * and fell through to a generic 500. The customer saw "something went
       * wrong" for a form error the UI could have explained, and the response
       * was indistinguishable from a real outage in the logs.
       */
      if (error instanceof StakeLimitError) {
        throw new ApiError(422, "STAKE_OUT_OF_RANGE", error.message);
      }
      throw error;
    }

    // The first combination doubles as "the bet" for a single or accumulator,
    // so an existing client keeps reading the same fields it always did.
    const placed = slip.placed[0]!;

    return NextResponse.json(
      {
        betId: placed.betId,
        slipId: slip.slipId,
        kind: slip.kind,
        combinationCount: slip.combinationCount,
        placedCount: slip.placed.length,
        // What was actually CHARGED. A partially placed system costs only what
        // landed, and saying so here is what stops a support ticket.
        totalStakeMinor: money(slip.totalStakeMinor),
        rejected: slip.rejected,
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
