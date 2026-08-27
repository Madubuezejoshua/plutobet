import type { OddsFormat } from "../users/schema";

/**
 * Displaying a price in the format the customer reads fluently.
 *
 * Decimal is the internal representation and the only one anything calculates
 * with. Fractional and American exist purely at the render boundary — a
 * conversion never round-trips back into pricing, settlement or the ledger,
 * because both are lossy and a bet must settle against the exact decimal the
 * customer accepted.
 *
 * Phase 2 stored an odds-format preference and nothing ever read it. This is
 * the module that makes it mean something.
 */

/** Prices are NUMERIC(7,3): three decimal places, so 0.0005 is below resolution. */
const DECIMAL_TOLERANCE = 0.0005;

/**
 * Largest denominator a fractional price may use.
 *
 * Bookmakers show human-readable fractions — 11/4, 100/30 — not 3163/1000.
 * Capping the denominator is what turns 1.333 into "1/3" rather than
 * "333/1000", and the cap is why the continued-fraction search below
 * terminates.
 */
const MAX_DENOMINATOR = 1000;

export function formatOdds(decimal: number, format: OddsFormat): string {
  switch (format) {
    case "FRACTIONAL":
      return toFractional(decimal);
    case "AMERICAN":
      return toAmerican(decimal);
    case "DECIMAL":
    default:
      return decimal.toFixed(2);
  }
}

/**
 * Decimal to fractional.
 *
 * Fractional odds express the PROFIT relative to the stake, so the decimal's
 * leading 1 (the returned stake) comes off first: 2.50 pays 1.5 times the
 * stake in profit, which is 3/2.
 *
 * The fraction is found by continued-fraction expansion rather than by
 * multiplying by 1000 and reducing. Reducing 1.333 that way gives 333/1000,
 * which is arithmetically correct and not what any bookmaker has ever
 * printed; the expansion finds 1/3, which is the price the trader meant.
 */
export function toFractional(decimal: number): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return "0/1";

  const profit = decimal - 1;
  const [numerator, denominator] = approximateFraction(profit);
  return `${numerator}/${denominator}`;
}

/**
 * Decimal to American (moneyline).
 *
 * Two branches meeting at evens:
 *   >= 2.0  the price pays more than the stake, quoted as profit on 100 staked
 *   <  2.0  the price pays less, quoted as the stake needed to win 100
 *
 * Evens is +100 by convention — not -100, and not 0.
 */
export function toAmerican(decimal: number): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return "0";

  if (decimal >= 2) {
    const value = Math.round((decimal - 1) * 100);
    return `+${value}`;
  }

  // Negative by construction here, so the sign comes from the number itself.
  const value = Math.round(-100 / (decimal - 1));
  return String(value);
}

/**
 * Best rational approximation of `value` with a bounded denominator.
 *
 * Continued-fraction expansion: repeatedly take the integer part, invert the
 * remainder, and build up numerator/denominator from the convergents. It
 * yields the closest fraction for any given denominator bound, which is
 * exactly the "nicest fraction that is still right" property wanted here.
 *
 * Terminates on three conditions, all of which are needed:
 *   - the remainder vanishes (an exact fraction such as 1.5)
 *   - the approximation is within display tolerance
 *   - the next denominator would exceed the cap
 */
function approximateFraction(value: number): [number, number] {
  let previousNumerator = 0;
  let numerator = 1;
  let previousDenominator = 1;
  let denominator = 0;
  let remainder = value;

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const whole = Math.floor(remainder);

    const nextNumerator = whole * numerator + previousNumerator;
    const nextDenominator = whole * denominator + previousDenominator;

    if (nextDenominator > MAX_DENOMINATOR) break;

    previousNumerator = numerator;
    numerator = nextNumerator;
    previousDenominator = denominator;
    denominator = nextDenominator;

    if (denominator > 0 && Math.abs(numerator / denominator - value) < DECIMAL_TOLERANCE) {
      break;
    }

    const fraction = remainder - whole;
    // An exact hit: the expansion has nothing left to refine.
    if (fraction < 1e-9) break;
    remainder = 1 / fraction;
  }

  if (denominator === 0) return [Math.round(value), 1];

  const divisor = greatestCommonDivisor(Math.abs(numerator), Math.abs(denominator));
  return [numerator / divisor, denominator / divisor];
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

/**
 * Fractional back to decimal.
 *
 * Provided for completeness and for tests. NOT used in any money path: a bet
 * settles against the decimal the customer accepted, never against a value
 * reconstructed from a display string.
 */
export function fractionalToDecimal(fraction: string): number | null {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(fraction.trim());
  if (!match) return null;

  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (denominator === 0) return null;

  return numerator / denominator + 1;
}

/** Short label for the format toggle. */
export const ODDS_FORMAT_LABELS: Record<OddsFormat, string> = {
  DECIMAL: "Decimal",
  FRACTIONAL: "Fractional",
  AMERICAN: "American",
};

/** An example price in each format, for the preferences screen. */
export function formatExample(format: OddsFormat): string {
  return formatOdds(2.5, format);
}
