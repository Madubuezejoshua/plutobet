/**
 * Cash-out pricing.
 *
 * Pure functions, integer maths, no I/O — same discipline as the settlement
 * rules, and for the same reason: this decides a payout, so an auditor has to
 * be able to reproduce any figure by hand.
 *
 * THE MODEL
 * A bet's fair value now is what it is expected to return, weighted by how
 * likely it still is to win:
 *
 *     fair = potentialReturn x P(remaining legs all win)
 *
 * Decimal odds imply a probability of 1/odds, so for the unsettled legs:
 *
 *     fair = stake x PRODUCT(locked odds) / PRODUCT(current odds)
 *
 * Legs already WON contribute their locked odds to the numerator and nothing
 * to the denominator — they are certain, not probable. Void legs ride at
 * 1.000 exactly as they do at settlement.
 *
 * The house margin is applied last. It is the reason cash-out is offered at
 * all: the operator buys the position back below fair value.
 */

export const ODDS_SCALE = 1000n;
const BASIS_POINTS = 10_000n;

export class CashOutUnavailableError extends Error {
  constructor(
    readonly reason:
      | "BET_NOT_PENDING"
      | "LEG_ALREADY_LOST"
      | "LEG_NOT_PRICEABLE"
      | "VALUE_TOO_SMALL"
      /*
       * The account may not make this decision right now: suspended, closed,
       * self-excluded, in a cooling-off period, or not the owner of the bet.
       *
       * Deliberately one reason for all of them. Telling an unauthenticated or
       * wrong caller WHICH of those applies leaks the state of somebody else's
       * account, and the customer's own state is already on their account page.
       */
      | "ACCOUNT_NOT_ELIGIBLE",
    message: string,
  ) {
    super(message);
    this.name = "CashOutUnavailableError";
  }
}

export type CashOutLegState =
  | { result: "PENDING"; lockedOddsScaled: bigint; currentOddsScaled: bigint | null }
  | { result: "WON"; lockedOddsScaled: bigint }
  | { result: "VOID" }
  | { result: "LOST" };

export interface CashOutQuote {
  /** What the position is worth before the operator's margin. */
  fairValueMinor: bigint;
  /** What the user is actually offered. */
  offerMinor: bigint;
  marginBasisPoints: number;
}

/**
 * Prices a cash-out offer.
 *
 * Refuses rather than guesses whenever the position cannot be valued: a lost
 * leg means the bet is already worthless, and an unpriced leg (suspended
 * market, pulled selection) means we do not know what it is worth. Offering a
 * number in either case is how an operator buys back a losing bet at a
 * premium.
 */
export function quoteCashOut(
  stakeMinor: bigint,
  legs: readonly CashOutLegState[],
  marginBasisPoints: number,
  minimumOfferMinor = 1n,
): CashOutQuote {
  if (legs.length === 0) throw new RangeError("a bet needs at least one leg");
  if (marginBasisPoints < 0 || marginBasisPoints >= 10_000) {
    throw new RangeError("margin must be between 0 and 10000 basis points");
  }

  let numerator = 1n; // product of locked odds still in play
  let numeratorScale = 0;
  let denominator = 1n; // product of current odds for unsettled legs
  let denominatorScale = 0;

  for (const leg of legs) {
    if (leg.result === "LOST") {
      throw new CashOutUnavailableError(
        "LEG_ALREADY_LOST",
        "this bet already contains a losing leg and has no value",
      );
    }
    if (leg.result === "VOID") continue; // rides at 1.000, both sides

    if (leg.result === "WON") {
      // Certain: it contributes its return, and no further uncertainty.
      numerator *= leg.lockedOddsScaled;
      numeratorScale += 1;
      continue;
    }

    if (leg.currentOddsScaled === null || leg.currentOddsScaled <= ODDS_SCALE) {
      throw new CashOutUnavailableError(
        "LEG_NOT_PRICEABLE",
        "one of the selections has no current price, so this bet cannot be valued",
      );
    }
    numerator *= leg.lockedOddsScaled;
    numeratorScale += 1;
    denominator *= leg.currentOddsScaled;
    denominatorScale += 1;
  }

  // Both products carry their own factors of ODDS_SCALE; cancel them once,
  // at the end, rather than dividing per leg — repeated division truncates
  // and would quietly shave the offer.
  const scaleAdjust = ODDS_SCALE ** BigInt(Math.max(denominatorScale - numeratorScale, 0));
  const inverseAdjust = ODDS_SCALE ** BigInt(Math.max(numeratorScale - denominatorScale, 0));

  const fairValueMinor =
    (stakeMinor * numerator * scaleAdjust) / (denominator * inverseAdjust);

  const offerMinor = (fairValueMinor * (BASIS_POINTS - BigInt(marginBasisPoints))) / BASIS_POINTS;

  if (offerMinor < minimumOfferMinor) {
    throw new CashOutUnavailableError(
      "VALUE_TOO_SMALL",
      "this bet is not worth enough to cash out",
    );
  }

  return { fairValueMinor, offerMinor, marginBasisPoints };
}
