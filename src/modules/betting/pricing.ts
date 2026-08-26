/**
 * Bet arithmetic. Every value here is an integer; no float ever touches a
 * price or a payout.
 *
 * Odds are stored as numeric(x,3), so they are treated as integers scaled by
 * 1000 ("2.100" -> 2100n). Multiplying scaled integers and dividing once at
 * the end keeps an accumulator exact, where multiplying JS numbers would
 * accumulate binary-fraction error — 2.1 * 3 is already 6.300000000000001,
 * and that error lands in someone's payout.
 */

export const ODDS_SCALE = 1000n;
const ODDS_DECIMALS = 3;

export class InvalidOddsError extends Error {
  constructor(readonly value: string) {
    super(`odds are not a usable decimal price: ${value}`);
    this.name = "InvalidOddsError";
  }
}

/**
 * Parses a NUMERIC(x,3) string into scaled integer odds.
 *
 * Deliberately string-based: routing through Number() first would round
 * "1.005" to a float before we ever got to scale it.
 */
export function parseOddsToScaled(value: string): bigint {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!match) throw new InvalidOddsError(value);

  const whole = match[1]!;
  const fraction = (match[2] ?? "").padEnd(ODDS_DECIMALS, "0");
  const scaled = BigInt(whole) * ODDS_SCALE + BigInt(fraction);

  // Decimal odds of 1.000 mean "stake returned, nothing won" — as a price
  // it is not a bet, and below 1 it returns less than the stake.
  if (scaled <= ODDS_SCALE) throw new InvalidOddsError(value);
  return scaled;
}

/** Renders scaled odds back to the NUMERIC(x,3) text form the DB stores. */
export function formatScaledOdds(scaled: bigint): string {
  const whole = scaled / ODDS_SCALE;
  const fraction = scaled % ODDS_SCALE;
  return `${whole}.${fraction.toString().padStart(ODDS_DECIMALS, "0")}`;
}

export interface BetPricing {
  /** Product of the leg odds, scaled by 1000. Display value. */
  totalOddsScaled: bigint;
  /** NUMERIC(12,3) text for bets.total_odds_decimal. */
  totalOddsDecimal: string;
  /** Authoritative payout on a full win, in kobo. */
  potentialReturnMinor: bigint;
  /** What the house stands to lose beyond keeping the stake. */
  liabilityMinor: bigint;
}

/**
 * Prices a slip from its leg odds and stake.
 *
 * The payout is computed from the RAW leg product, not from the rounded
 * `totalOddsDecimal`. Rounding the total first and then multiplying rounds
 * twice, and the second rounding can move the payout off what the user was
 * quoted. The rounded total is carried for display and reporting only.
 *
 * The final division floors, so a fractional kobo is never paid out. That
 * favours the house by at most 1 kobo per bet; the alternative (rounding up)
 * pays money the arithmetic did not produce. Documented rather than silent.
 */
export function priceBet(legOddsScaled: readonly bigint[], stakeMinor: bigint): BetPricing {
  if (legOddsScaled.length === 0) throw new RangeError("a bet needs at least one leg");
  if (stakeMinor <= 0n) throw new RangeError("stake must be positive");

  let productScaled = 1n;
  for (const odds of legOddsScaled) {
    if (odds <= ODDS_SCALE) throw new InvalidOddsError(formatScaledOdds(odds));
    productScaled *= odds;
  }

  // The product of N legs carries N factors of ODDS_SCALE.
  const payoutDivisor = ODDS_SCALE ** BigInt(legOddsScaled.length);
  // ...so bringing it back to a single scaled value drops only N-1 of them.
  // Dividing by the full payoutDivisor here would yield the bare multiplier
  // and render 2.000 as "0.002".
  const displayDivisor = ODDS_SCALE ** BigInt(legOddsScaled.length - 1);

  // Round half-up, for the display total only.
  const totalOddsScaled = (productScaled * 2n + displayDivisor) / (displayDivisor * 2n);

  // Payout from the raw product: one rounding, at the end.
  const potentialReturnMinor = (stakeMinor * productScaled) / payoutDivisor;

  return {
    totalOddsScaled,
    totalOddsDecimal: formatScaledOdds(totalOddsScaled),
    potentialReturnMinor,
    liabilityMinor: potentialReturnMinor - stakeMinor,
  };
}
