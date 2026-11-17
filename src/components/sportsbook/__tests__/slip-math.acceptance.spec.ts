import { describe, expect, it } from "vitest";
import { slipMath, toKobo } from "../slip-math";

/**
 * The betslip's arithmetic.
 *
 * These are the numbers a customer reads immediately before agreeing to give
 * up money, so they are tested directly rather than through a rendered
 * component: what matters is the value, not the markup it lands in.
 */

describe("toKobo", () => {
  it("reads whole naira", () => {
    expect(toKobo("100")).toBe(10_000n);
    expect(toKobo("1")).toBe(100n);
  });

  it("reads one and two decimal places", () => {
    expect(toKobo("100.5")).toBe(10_050n);
    expect(toKobo("100.55")).toBe(10_055n);
    expect(toKobo("0.01")).toBe(1n);
  });

  it("ignores surrounding whitespace", () => {
    expect(toKobo("  250.25  ")).toBe(25_025n);
  });

  it("never uses floating point", () => {
    // 0.29 * 100 is 28.999999999999996 in IEEE-754. A parser built on
    // Number would truncate this to 28 kobo and short-change the customer.
    expect(toKobo("0.29")).toBe(29n);
    expect(toKobo("1.15")).toBe(115n);
    expect(toKobo("8.87")).toBe(887n);
  });

  it("refuses anything that is not a plain amount", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "1,000", // thousands separator
      "N100", // currency prefix
      "100.555", // three decimals is not a kobo amount
      "-100", // a negative stake
      "+100",
      "1e3", // exponent
      ".5", // no whole part
      "100.", // trailing point
      "1234567890", // ten digits, beyond any legitimate stake
      "Infinity",
      "NaN",
    ]) {
      expect(toKobo(bad), `expected ${JSON.stringify(bad)} to be refused`).toBeNull();
    }
  });
});

describe("slipMath", () => {
  it("prices a single", () => {
    const { totalOdds, returnMinor, profitMinor } = slipMath([{ odds: 2.15 }], 20_000n);
    expect(totalOdds).toBeCloseTo(2.15, 10);
    expect(returnMinor).toBe(43_000n); // 200.00 at 2.15 returns 430.00
    expect(profitMinor).toBe(23_000n); // and the profit is 230.00
  });

  it("multiplies the legs of an accumulator", () => {
    const { totalOdds, returnMinor } = slipMath(
      [{ odds: 2 }, { odds: 1.5 }, { odds: 3 }],
      10_000n,
    );
    expect(totalOdds).toBeCloseTo(9, 10);
    expect(returnMinor).toBe(90_000n);
  });

  it("never labels the gross return as profit", () => {
    // The single most common way a betslip misleads: the return includes the
    // stake and the profit does not, and they must differ by exactly it.
    const stake = 55_500n;
    const { returnMinor, profitMinor } = slipMath([{ odds: 1.91 }], stake);
    expect(returnMinor - profitMinor).toBe(stake);
  });

  it("shows nothing before a stake is entered", () => {
    const { returnMinor, profitMinor } = slipMath([{ odds: 2.5 }], 0n);
    expect(returnMinor).toBe(0n);
    expect(profitMinor).toBe(0n);
  });

  it("treats an empty slip as odds of one", () => {
    const { totalOdds, returnMinor, profitMinor } = slipMath([], 10_000n);
    expect(totalOdds).toBe(1);
    expect(returnMinor).toBe(10_000n);
    expect(profitMinor).toBe(0n);
  });

  it("rounds to the nearest kobo rather than truncating", () => {
    // 333 kobo at 1.005 is 334.665 kobo. Truncating would show 334 and the
    // customer would be paid 335, which reads as being short-changed.
    expect(slipMath([{ odds: 1.005 }], 333n).returnMinor).toBe(335n);
  });
});
