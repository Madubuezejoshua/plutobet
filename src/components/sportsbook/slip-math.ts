/**
 * Betslip arithmetic.
 *
 * Pulled out of the components so it can be tested without a DOM. These two
 * functions decide what number a customer is shown before they part with
 * money, which makes them the part of the redesign most worth testing and the
 * part least worth testing through a rendered component.
 */

export interface SlipLeg {
  odds: number;
}

/**
 * Naira as typed by a customer, to integer kobo.
 *
 * Returns null for anything that is not a plain amount. Deliberately strict:
 * no thousands separators, no currency symbol, no leading `+`, no exponent.
 * A parser that guesses at "1,0O0" eventually guesses wrong about somebody's
 * stake.
 *
 * The whole part is capped at nine digits because the stake is submitted as an
 * integer string and priced against a balance; there is no legitimate stake
 * near ₦1,000,000,000, and refusing early beats overflowing later.
 */
export function toKobo(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
}

/**
 * What the slip is worth.
 *
 * `returnMinor` is GROSS — it includes the stake. `profitMinor` is what the
 * customer actually gains. Both are returned so the UI cannot accidentally
 * label one as the other, which is the single most common way a betslip
 * overstates a win.
 *
 * The multiplication runs through `Number` because decimal odds are decimal
 * fractions and BigInt cannot hold them. That is safe HERE and nowhere else:
 * this figure is a preview, the server re-prices the bet from stored odds
 * under a lock, and its answer is the one that is paid. The rounding is to the
 * nearest kobo so the preview cannot be a kobo under what is paid, which would
 * read as being short-changed.
 */
export function slipMath(picks: readonly SlipLeg[], stakeMinor: bigint) {
  const totalOdds = picks.reduce((acc, pick) => acc * pick.odds, 1);
  const returnMinor =
    stakeMinor > 0n ? BigInt(Math.round(Number(stakeMinor) * totalOdds)) : 0n;
  const profitMinor = returnMinor > 0n ? returnMinor - stakeMinor : 0n;
  return { totalOdds, returnMinor, profitMinor };
}
