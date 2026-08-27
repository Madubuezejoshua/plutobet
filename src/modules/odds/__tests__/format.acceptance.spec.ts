import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatOdds, fractionalToDecimal, toAmerican, toFractional } from "../format";

/**
 * Odds formats are a DISPLAY concern. Nothing here feeds pricing, settlement
 * or the ledger — both alternative formats are lossy, and a bet must settle
 * against the exact decimal the customer accepted.
 *
 * What these tests protect is that the number a customer reads means the same
 * thing whichever format they read it in.
 */
describe("fractional odds", () => {
  describe("prices a trader would recognise", () => {
    it.each([
      [2.0, "1/1"], // evens
      [1.5, "1/2"],
      [2.5, "3/2"],
      [3.0, "2/1"],
      [1.25, "1/4"],
      [5.0, "4/1"],
      [1.2, "1/5"],
      [4.5, "7/2"],
      [3.75, "11/4"],
    ])("%s -> %s", (decimal, expected) => {
      expect(toFractional(decimal)).toBe(expected);
    });

    /*
     * The reason this uses continued fractions instead of "multiply by 1000
     * and reduce". 1.333 is a trader's 1/3; reducing 333/1000 gives
     * 333/1000, which is arithmetically right and has never appeared on a
     * betting slip.
     */
    it("recovers the intended fraction from a rounded decimal", () => {
      expect(toFractional(1.333)).toBe("1/3");
      expect(toFractional(1.667)).toBe("2/3");
      expect(toFractional(1.143)).toBe("1/7");
    });
  });

  it("round-trips back to the original decimal within display tolerance", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1010, max: 50_000 }), (scaled) => {
        const decimal = scaled / 1000;
        const back = fractionalToDecimal(toFractional(decimal));
        expect(back).not.toBeNull();
        // Within half a tick of a NUMERIC(7,3) price.
        expect(Math.abs(back! - decimal)).toBeLessThan(0.01);
      }),
      { numRuns: 500 },
    );
  });

  it("never emits a denominator too large to read", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1010, max: 50_000 }), (scaled) => {
        const [, denominator] = toFractional(scaled / 1000).split("/");
        expect(Number(denominator)).toBeLessThanOrEqual(1000);
      }),
      { numRuns: 500 },
    );
  });

  it("always reduces to lowest terms", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1010, max: 50_000 }), (scaled) => {
        const [n, d] = toFractional(scaled / 1000).split("/").map(Number);
        let a = n!;
        let b = d!;
        while (b !== 0) [a, b] = [b, a % b];
        expect(a).toBe(1);
      }),
      { numRuns: 300 },
    );
  });

  it("refuses to price something that cannot lose", () => {
    // A decimal of 1.0 or below is not a price; it is a bug upstream.
    expect(toFractional(1)).toBe("0/1");
    expect(toFractional(0.5)).toBe("0/1");
    expect(toFractional(Number.NaN)).toBe("0/1");
  });
});

describe("american odds", () => {
  describe("the two branches and where they meet", () => {
    it.each([
      [2.5, "+150"],
      [3.0, "+200"],
      [5.0, "+400"],
      [1.5, "-200"],
      [1.25, "-400"],
      [1.8, "-125"],
    ])("%s -> %s", (decimal, expected) => {
      expect(toAmerican(decimal)).toBe(expected);
    });

    /*
     * Evens is +100 by convention — not -100 and not 0. It is the exact point
     * where the formula changes branch, so it is the one worth pinning.
     */
    it("quotes evens as +100", () => {
      expect(toAmerican(2.0)).toBe("+100");
    });

    it("switches sign exactly at evens", () => {
      expect(toAmerican(2.001).startsWith("+")).toBe(true);
      expect(toAmerican(1.999).startsWith("-")).toBe(true);
    });
  });

  it("signs every price, so the direction is never ambiguous", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1010, max: 50_000 }), (scaled) => {
        const american = toAmerican(scaled / 1000);
        expect(american).toMatch(/^[+-]\d+$/);
      }),
      { numRuns: 500 },
    );
  });

  it("gives a bigger payout a bigger positive number", () => {
    const shorter = Number(toAmerican(2.5).replace("+", ""));
    const longer = Number(toAmerican(4.0).replace("+", ""));
    expect(longer).toBeGreaterThan(shorter);
  });
});

describe("formatOdds", () => {
  it("renders decimal to two places", () => {
    expect(formatOdds(2.5, "DECIMAL")).toBe("2.50");
    expect(formatOdds(2, "DECIMAL")).toBe("2.00");
  });

  it("dispatches to each format", () => {
    expect(formatOdds(2.5, "FRACTIONAL")).toBe("3/2");
    expect(formatOdds(2.5, "AMERICAN")).toBe("+150");
  });

  /*
   * The property that matters to a customer: the three strings are three
   * spellings of one price, so a slip does not change value when they switch
   * the toggle.
   */
  it("keeps the three formats describing the same price", () => {
    for (const decimal of [1.5, 2.0, 2.5, 3.0, 4.5, 10.0]) {
      const fromFraction = fractionalToDecimal(formatOdds(decimal, "FRACTIONAL"))!;
      const american = Number(formatOdds(decimal, "AMERICAN"));
      const fromAmerican = american > 0 ? american / 100 + 1 : 100 / -american + 1;

      expect(Math.abs(fromFraction - decimal)).toBeLessThan(0.01);
      expect(Math.abs(fromAmerican - decimal)).toBeLessThan(0.01);
    }
  });
});
