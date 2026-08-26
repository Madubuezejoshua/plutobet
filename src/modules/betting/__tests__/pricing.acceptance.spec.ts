import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatScaledOdds,
  InvalidOddsError,
  ODDS_SCALE,
  parseOddsToScaled,
  priceBet,
} from "../pricing";

describe("odds parsing", () => {
  it("scales decimal odds without going through a float", () => {
    expect(parseOddsToScaled("2.100")).toBe(2100n);
    expect(parseOddsToScaled("1.005")).toBe(1005n);
    expect(parseOddsToScaled("10")).toBe(10_000n);
    expect(parseOddsToScaled("1.5")).toBe(1500n);
  });

  it("round-trips through the stored text form", () => {
    for (const value of ["2.100", "1.005", "10.000", "999.999"]) {
      expect(formatScaledOdds(parseOddsToScaled(value))).toBe(
        value.includes(".") ? value.padEnd(value.indexOf(".") + 4, "0") : value,
      );
    }
  });

  it("rejects a price that cannot win the user anything", () => {
    // 1.000 returns exactly the stake; below that it returns less.
    expect(() => parseOddsToScaled("1.000")).toThrow(InvalidOddsError);
    expect(() => parseOddsToScaled("0.500")).toThrow(InvalidOddsError);
    expect(() => parseOddsToScaled("")).toThrow(InvalidOddsError);
    expect(() => parseOddsToScaled("abc")).toThrow(InvalidOddsError);
    expect(() => parseOddsToScaled("-2.000")).toThrow(InvalidOddsError);
  });
});

describe("bet pricing", () => {
  it("prices a single exactly", () => {
    const pricing = priceBet([parseOddsToScaled("2.000")], 100_000n);
    expect(pricing.totalOddsDecimal).toBe("2.000");
    expect(pricing.potentialReturnMinor).toBe(200_000n);
    expect(pricing.liabilityMinor).toBe(100_000n);
  });

  it("prices an accumulator exactly", () => {
    const legs = ["2.100", "1.500", "3.400"].map(parseOddsToScaled);
    const pricing = priceBet(legs, 100_000n);
    expect(pricing.totalOddsDecimal).toBe("10.710");
    expect(pricing.potentialReturnMinor).toBe(1_071_000n);
  });

  /**
   * The concrete reason money never touches a float here.
   *
   * Three legs at 1.010 on a ₦10,000 stake owe exactly 1,030,301 kobo. The
   * IEEE-754 product lands a hair below, and flooring — which is what a
   * payout does — turns that into 1,030,300: a kobo short of what the user
   * is owed, on every bet of this shape.
   */
  it("pays the kobo a float would silently swallow", () => {
    const stake = 1_000_000n;
    const legs = ["1.010", "1.010", "1.010"].map(parseOddsToScaled);

    expect(priceBet(legs, stake).potentialReturnMinor).toBe(1_030_301n);
    expect(Math.floor(1_000_000 * (1.01 * 1.01 * 1.01))).toBe(1_030_300);
  });

  it("floors a fractional kobo rather than inventing one", () => {
    // 1.005 * 333 kobo = 334.665 kobo.
    const pricing = priceBet([parseOddsToScaled("1.005")], 333n);
    expect(pricing.potentialReturnMinor).toBe(334n);
  });

  it("derives the payout from the leg odds, not the rounded total", () => {
    // Three legs whose product does not land on 3 decimals. Pricing from the
    // rounded total would give a different (wrong) payout.
    const legs = ["1.333", "1.333", "1.333"].map(parseOddsToScaled);
    const stake = 1_000_000n;
    const pricing = priceBet(legs, stake);

    const rounded = parseOddsToScaled(pricing.totalOddsDecimal);
    const fromRoundedTotal = (stake * rounded) / ODDS_SCALE;

    expect(pricing.potentialReturnMinor).not.toBe(fromRoundedTotal);
    // The exact product is 2.368593037; flooring 1_000_000 * that gives:
    expect(pricing.potentialReturnMinor).toBe(2_368_593n);
  });

  it("rejects an empty slip or a non-positive stake", () => {
    expect(() => priceBet([], 100n)).toThrow(RangeError);
    expect(() => priceBet([2000n], 0n)).toThrow(RangeError);
    expect(() => priceBet([2000n], -5n)).toThrow(RangeError);
  });
});

describe("pricing properties", () => {
  const oddsArb = fc
    .integer({ min: 1001, max: 50_000 })
    .map((scaled) => BigInt(scaled));
  const stakeArb = fc.integer({ min: 1, max: 50_000_000 }).map((v) => BigInt(v));

  it("never returns less than the stake, for any valid slip", () => {
    fc.assert(
      fc.property(fc.array(oddsArb, { minLength: 1, maxLength: 6 }), stakeArb, (legs, stake) => {
        const pricing = priceBet(legs, stake);
        // Every leg is > 1.000, so the payout must at least return the stake;
        // the bets_return_covers_stake CHECK depends on this holding.
        expect(pricing.potentialReturnMinor >= stake).toBe(true);
        expect(pricing.liabilityMinor >= 0n).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("is order-independent — a slip prices the same however it is sorted", () => {
    fc.assert(
      fc.property(fc.array(oddsArb, { minLength: 2, maxLength: 6 }), stakeArb, (legs, stake) => {
        const forward = priceBet(legs, stake);
        const reversed = priceBet([...legs].reverse(), stake);
        expect(reversed.potentialReturnMinor).toBe(forward.potentialReturnMinor);
        expect(reversed.totalOddsDecimal).toBe(forward.totalOddsDecimal);
      }),
      { numRuns: 300 },
    );
  });

  it("is monotonic in the stake — more stake never returns less", () => {
    fc.assert(
      fc.property(
        fc.array(oddsArb, { minLength: 1, maxLength: 4 }),
        stakeArb,
        stakeArb,
        (legs, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(priceBet(legs, hi).potentialReturnMinor).toBeGreaterThanOrEqual(
            priceBet(legs, lo).potentialReturnMinor,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
