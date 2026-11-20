import { describe, expect, it } from "vitest";
import {
  ACCA_BOOST_MIN_LEG_ODDS,
  ACCA_BOOST_TIERS,
  accaBoostPreview,
  slipMath,
  toKobo,
} from "../slip-math";
import {
  ALL_SPORT_KEYS,
  PRIMARY_SPORT_KEYS,
  SPORTS_CATALOG,
  leaguePriority,
  resolveSportKey,
} from "@/modules/odds/sports-catalog";

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

describe("accaBoostPreview", () => {
  it("excludes legs below minimum qualifying odds (1.25)", () => {
    const picks = [
      { odds: 1.1 },
      { odds: 1.24 },
      { odds: ACCA_BOOST_MIN_LEG_ODDS },
      { odds: 1.8 },
    ];
    const stake = 10_000n;
    const { returnMinor } = slipMath(picks, stake);
    const boost = accaBoostPreview(picks, stake, returnMinor);

    expect(boost.qualifyingLegs).toBe(2);
    expect(boost.currentPercent).toBe(0);
    expect(boost.nextTierLegs).toBe(3);
    expect(boost.nextTierPercent).toBe(3);
    expect(boost.legsNeededForNext).toBe(1);
    expect(boost.estimatedBonusMinor).toBe(0n);
  });

  it("computes net-profit bonus accurately at 3, 5, and 10+ qualifying legs", () => {
    const stake = 10_000n;

    // 3 qualifying legs -> +3% on net profit
    const legs3 = [{ odds: 2 }, { odds: 2 }, { odds: 1.5 }]; // totalOdds = 6, return = 60_000n, profit = 50_000n
    const b3 = accaBoostPreview(legs3, stake, slipMath(legs3, stake).returnMinor);
    expect(b3.currentPercent).toBe(3);
    expect(b3.estimatedBonusMinor).toBe(1_500n); // 3% of 50_000n
    expect(b3.nextTierLegs).toBe(4);
    expect(b3.nextTierPercent).toBe(5);

    // 5 qualifying legs -> +10% on net profit
    const legs5 = Array.from({ length: 5 }, () => ({ odds: 2 })); // return = 320_000n, profit = 310_000n
    const b5 = accaBoostPreview(legs5, stake, slipMath(legs5, stake).returnMinor);
    expect(b5.currentPercent).toBe(10);
    expect(b5.estimatedBonusMinor).toBe(31_000n);
    expect(b5.progressPercent).toBe(50);

    // 12 qualifying legs -> capped at top tier (+50%)
    const legs12 = Array.from({ length: 12 }, () => ({ odds: 1.3 }));
    const { returnMinor: ret12 } = slipMath(legs12, stake);
    const b12 = accaBoostPreview(legs12, stake, ret12);
    expect(b12.currentPercent).toBe(ACCA_BOOST_TIERS[ACCA_BOOST_TIERS.length - 1]!.percent);
    expect(b12.nextTierLegs).toBeNull();
    expect(b12.legsNeededForNext).toBe(0);
    expect(b12.progressPercent).toBe(100);
    expect(b12.estimatedBonusMinor).toBe(((ret12 - stake) * 50n) / 100n);
  });
});

describe("SPORTS_CATALOG", () => {
  it("exposes all 13 sports with 5 primary sports synced first", () => {
    expect(SPORTS_CATALOG).toHaveLength(13);
    expect(ALL_SPORT_KEYS).toHaveLength(13);
    expect(PRIMARY_SPORT_KEYS).toEqual([
      "football",
      "basketball",
      "tennis",
      "table-tennis",
      "esports",
    ]);
    expect(new Set(ALL_SPORT_KEYS).size).toBe(13);
  });

  it("resolves valid sport keys and falls back to football", () => {
    expect(resolveSportKey("ice-hockey")).toBe("ice-hockey");
    expect(resolveSportKey("mma")).toBe("mma");
    expect(resolveSportKey("  MIXED-MARTIAL-ARTS ")).toBe("mma");
    expect(resolveSportKey("unknown-sport")).toBe("football");
    expect(resolveSportKey(undefined)).toBe("football");
  });

  it("ranks marquee competitions ahead of lower-tier leagues", () => {
    expect(leaguePriority("football", "England - Premier League")).toBeLessThan(
      leaguePriority("football", "Regional Amateur Cup"),
    );
    expect(leaguePriority("basketball", "USA - NBA")).toBeLessThan(
      leaguePriority("basketball", "Club Friendly"),
    );
  });
});

