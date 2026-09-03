import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { cashOutService } from "@/modules/betting/cashout.service";
import { CashOutUnavailableError } from "@/modules/betting/cashout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cash-out: buying a bet back before it settles.
 *
 * TWO VERBS, AND THE DIFFERENCE MATTERS.
 *
 *   GET   prices the position and takes nothing. Read-only.
 *   POST  takes the offer. Moves money.
 *
 * They are separate because a quote is something a customer refreshes while
 * watching a match, and a route that priced and paid in one call would make
 * every refresh a payment.
 *
 * THE USER ID IS NEVER IN THE REQUEST. It comes from the authenticated session
 * through `authedRoute`, so no body, query string or header can cash out
 * somebody else's bet. The service checks ownership again under the bet's row
 * lock, because a boundary check alone is a check one refactor away from being
 * skipped.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO. It does not price anything, decide
 * eligibility, or touch a balance. Every one of those lives in
 * `CashOutService`, which is reachable from an admin tool and a background job
 * as well as from here — a rule enforced only at the HTTP edge is not enforced.
 */

const takeSchema = z
  .object({
    /*
     * Absent means the whole bet. Present means buy back this much of the
     * ORIGINAL stake and leave the rest running.
     *
     * A string, parsed to BigInt, for the same reason a stake is: a JSON number
     * loses precision above 2^53 and accepts 100.5 kobo, which is not a
     * quantity of money that exists.
     */
    stakePortionMinor: z
      .string()
      .regex(/^\d+$/, "the portion must be a whole number of kobo")
      .transform((value) => BigInt(value))
      .refine((value) => value > 0n, "the portion must be greater than zero")
      .optional(),

    /*
     * The offer the customer was SHOWN, as a guard rather than an input.
     *
     * The service re-prices under the bet's row lock and refuses if the fresh
     * offer is lower than this, so nobody is paid less than they accepted. A
     * HIGHER offer is paid in full — the customer is not penalised for the
     * seconds between seeing a price and taking it.
     *
     * Omitting it means "take whatever it is worth now", which is a legitimate
     * choice and the only one available to a caller that never displayed a
     * quote.
     */
    expectedOfferMinor: z
      .string()
      .regex(/^\d+$/, "the expected offer must be a whole number of kobo")
      .transform((value) => BigInt(value))
      .optional(),

    /*
     * Accepted for request tracing and refused if malformed, but NOT used as
     * the money key.
     *
     * The money key is derived from the bet, which is strictly stronger: a
     * client-supplied key protects only against that client's own retries, and
     * a client that generates a fresh key on every attempt would defeat it. A
     * bet can be cashed out exactly once, so keying on the bet holds regardless
     * of what the client sends.
     */
    idempotencyKey: z.string().min(8).max(200).optional(),
  })
  .strict();

/** Prices the position without taking it. */
export const GET = authedRoute(
  "cashOut",
  RATE_RULES.cashOut,
  async ({ request, userId }: AuthedRouteContext) => {
    const betId = betIdFrom(request.url);

    try {
      const quote = await cashOutService.quoteFor(betId, userId);
      return NextResponse.json({
        betId,
        available: true,
        fairValueMinor: money(quote.fairValueMinor),
        offerMinor: money(quote.offerMinor),
      });
    } catch (error) {
      /*
       * A refusal to QUOTE is not an error condition for the customer — a leg
       * has lost, a market is suspended, the bet is already settled. The page
       * needs to say "not available right now" and why, so this answers 200
       * with `available: false` rather than a status the UI has to treat as a
       * failure.
       *
       * An ineligible ACCOUNT is different and stays an error: that is about
       * the person, not the position, and it must not be reported as a market
       * condition.
       */
      if (error instanceof CashOutUnavailableError) {
        if (error.reason === "ACCOUNT_NOT_ELIGIBLE") throw toApiError(error);
        return NextResponse.json({
          betId,
          available: false,
          reason: error.reason,
          message: error.message,
        });
      }
      throw error;
    }
  },
);

/** Takes the offer, in full or in part. */
export const POST = authedRoute(
  "cashOut",
  RATE_RULES.cashOut,
  async ({ request, userId, ip }: AuthedRouteContext) => {
    const betId = betIdFrom(request.url);
    const body = takeSchema.parse(await readJson(request));

    try {
      if (body.stakePortionMinor === undefined) {
        const result = await cashOutService.cashOut({
          betId,
          userId,
          ip,
          expectedOfferMinor: body.expectedOfferMinor,
        });
        return NextResponse.json({
          betId: result.betId,
          kind: "FULL",
          offerMinor: money(result.offerMinor),
          balanceAfterMinor: money(result.balanceAfterMinor),
          remainingStakeMinor: money(0n),
          // True when the cash-out had already happened and this request found
          // it. The customer is shown what they were paid either way.
          replayed: result.replayed === true,
        });
      }

      const result = await cashOutService.cashOutPartial({
        betId,
        userId,
        ip,
        stakePortionMinor: body.stakePortionMinor,
        expectedOfferMinor: body.expectedOfferMinor,
      });
      return NextResponse.json({
        betId: result.betId,
        kind: "PARTIAL",
        offerMinor: money(result.offerMinor),
        balanceAfterMinor: money(result.balanceAfterMinor),
        remainingStakeMinor: money(result.remainingStakeMinor),
        replayed: false,
      });
    } catch (error) {
      if (error instanceof CashOutUnavailableError) throw toApiError(error);
      throw error;
    }
  },
);

/**
 * The bet id, from the path.
 *
 * Read from the URL rather than taken as a route parameter because this file's
 * two handlers are wrapped, and the wrapper receives the request rather than
 * the segment context. Validated as a UUID so a malformed id is a 422 at the
 * boundary instead of a database error further in.
 */
function betIdFrom(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const betId = segments[segments.length - 2];
  const parsed = z.string().uuid().safeParse(betId);
  if (!parsed.success) throw new ApiError(422, "INVALID_BET_ID", "that is not a bet id");
  return parsed.data;
}

/** An absent body means "take the whole bet with no guard". */
async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(422, "INVALID_BODY", "the request body is not valid JSON");
  }
}

/**
 * Each refusal reason to the status it deserves.
 *
 * They are not all the same class of problem, and collapsing them into one code
 * would leave the customer with "something went wrong" for four situations the
 * interface can explain precisely.
 */
function toApiError(error: CashOutUnavailableError): ApiError {
  switch (error.reason) {
    // The account may not make this decision: suspended, closed, self-excluded,
    // in a cooling-off period, or not the owner. One code for all of them, so
    // the response cannot be used to discover which bets exist or what state
    // somebody else's account is in.
    case "ACCOUNT_NOT_ELIGIBLE":
      return new ApiError(403, "ACCOUNT_NOT_ELIGIBLE", error.message);

    // The bet has moved on — settled, voided, already cashed out. A conflict,
    // because the request was valid when it was formed.
    case "BET_NOT_PENDING":
      return new ApiError(409, "BET_NOT_PENDING", error.message);

    // A leg has already lost, so the position is worth nothing and there is
    // nothing to buy back.
    case "LEG_ALREADY_LOST":
      return new ApiError(409, "LEG_ALREADY_LOST", error.message);

    // A market is suspended or closed, so there is no price to value it at.
    // Temporary by nature, and the UI should invite a retry.
    case "LEG_NOT_PRICEABLE":
      return new ApiError(409, "LEG_NOT_PRICEABLE", error.message);

    // The offer is below the minimum, or the requested portion prices to zero.
    // The customer asked for something the book will not do, which is a request
    // problem rather than a state problem.
    case "VALUE_TOO_SMALL":
      return new ApiError(422, "VALUE_TOO_SMALL", error.message);
  }
}
