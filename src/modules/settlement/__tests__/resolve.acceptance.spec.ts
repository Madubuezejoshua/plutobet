import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { priceBet } from "@/modules/betting/pricing";
import {
  resolveBet,
  resolveLeg,
  settlementPayoutMinor,
  UnsettleableError,
  type MatchResult,
} from "../resolve";

const played = (periods: MatchResult["periods"]): MatchResult => ({
  status: "SETTLED",
  periods,
});

/**
 * A cup tie: 1-1 after 90 minutes, 1-1 after extra time, won 4-2 on penalties.
 * The trophy went to the home side; every match-result market is a DRAW.
 */
const CUP_TIE = played({
  p1: { home: 0, away: 1 },
  ft: { home: 1, away: 1 },
  ot: { home: 1, away: 1 },
  ap: { home: 5, away: 3 },
});

describe("invariant 10 — regulation score, not the trophy", () => {
  it("settles 1X2 as a draw when the match was won on penalties", () => {
    // Settling against ap/ot here pays the home backer on every knockout tie.
    expect(resolveLeg("1x2", "draw", null, CUP_TIE)).toBe("WON");
    expect(resolveLeg("1x2", "home", null, CUP_TIE)).toBe("LOST");
    expect(resolveLeg("1x2", "away", null, CUP_TIE)).toBe("LOST");
  });

  it("applies the same rule to double chance, BTTS and correct score", () => {
    expect(resolveLeg("double_chance", "home_or_draw", null, CUP_TIE)).toBe("WON");
    expect(resolveLeg("double_chance", "home_or_away", null, CUP_TIE)).toBe("LOST");
    // 1-1 in regulation: both scored. The 5-3 shootout is not goals.
    expect(resolveLeg("btts", "yes", null, CUP_TIE)).toBe("WON");
    expect(resolveLeg("correct_score", "1-1", null, CUP_TIE)).toBe("WON");
    expect(resolveLeg("correct_score", "5-3", null, CUP_TIE)).toBe("LOST");
  });

  it("refuses to settle when the regulation score is missing", () => {
    const noFt = played({ ot: { home: 2, away: 1 } });
    expect(() => resolveLeg("1x2", "home", null, noFt)).toThrow(UnsettleableError);
  });
});

describe("1X2 and double chance", () => {
  const homeWin = played({ ft: { home: 2, away: 0 } });

  it("resolves a home win", () => {
    expect(resolveLeg("1x2", "home", null, homeWin)).toBe("WON");
    expect(resolveLeg("1x2", "draw", null, homeWin)).toBe("LOST");
    expect(resolveLeg("double_chance", "home_or_draw", null, homeWin)).toBe("WON");
    expect(resolveLeg("double_chance", "draw_or_away", null, homeWin)).toBe("LOST");
  });

  it("rejects an unknown selection key rather than guessing", () => {
    expect(() => resolveLeg("1x2", "sometimes", null, homeWin)).toThrow(UnsettleableError);
  });
});

describe("over/under", () => {
  const threeGoals = played({ ft: { home: 2, away: 1 } });

  it("resolves a half line", () => {
    expect(resolveLeg("over_under", "over_2.5", "2.50", threeGoals)).toBe("WON");
    expect(resolveLeg("over_under", "under_2.5", "2.50", threeGoals)).toBe("LOST");
  });

  it("voids a whole line that lands exactly", () => {
    const twoGoals = played({ ft: { home: 1, away: 1 } });
    expect(resolveLeg("over_under", "over_2", "2.00", twoGoals)).toBe("VOID");
    expect(resolveLeg("over_under", "under_2", "2.00", twoGoals)).toBe("VOID");
  });

  it("refuses a quarter line instead of paying the wrong amount", () => {
    // .25 lines split the stake — a shape WON|LOST|VOID cannot express.
    expect(() => resolveLeg("over_under", "over_2.25", "2.25", threeGoals)).toThrow(
      UnsettleableError,
    );
  });

  it("refuses a missing line", () => {
    expect(() => resolveLeg("over_under", "over_2.5", null, threeGoals)).toThrow(UnsettleableError);
  });
});

describe("handicap", () => {
  const threeOne = played({ ft: { home: 3, away: 1 } });

  it("applies the line to the named side", () => {
    expect(resolveLeg("handicap", "home_-1.5", "-1.50", threeOne)).toBe("WON");
    expect(resolveLeg("handicap", "home_-2.5", "-2.50", threeOne)).toBe("LOST");
    expect(resolveLeg("handicap", "away_1.5", "1.50", threeOne)).toBe("LOST");
    expect(resolveLeg("handicap", "away_2.5", "2.50", threeOne)).toBe("WON");
  });

  it("voids a whole-line push", () => {
    // home -2 against a 2-goal win is exactly level.
    expect(resolveLeg("handicap", "home_-2", "-2.00", threeOne)).toBe("VOID");
  });
});

describe("half-time / full-time", () => {
  it("settles against both periods", () => {
    // Trailing at the break, level at the end.
    expect(resolveLeg("ht_ft", "away/draw", null, CUP_TIE)).toBe("WON");
    expect(resolveLeg("ht_ft", "home/draw", null, CUP_TIE)).toBe("LOST");
    expect(resolveLeg("ht_ft", "away/away", null, CUP_TIE)).toBe("LOST");
  });

  it("refuses when the half-time score is missing", () => {
    const noHalf = played({ ft: { home: 1, away: 1 } });
    expect(() => resolveLeg("ht_ft", "draw/draw", null, noHalf)).toThrow(UnsettleableError);
  });
});

describe("cancelled matches", () => {
  it("voids every leg regardless of the partial score", () => {
    const abandoned: MatchResult = {
      status: "CANCELLED",
      periods: { p1: { home: 3, away: 0 }, ft: { home: 3, away: 0 } },
    };
    expect(resolveLeg("1x2", "home", null, abandoned)).toBe("VOID");
    expect(resolveLeg("over_under", "over_2.5", "2.50", abandoned)).toBe("VOID");
    expect(resolveLeg("btts", "no", null, abandoned)).toBe("VOID");
  });
});

describe("folding legs into a bet", () => {
  it("wins a single", () => {
    const bet = resolveBet([{ outcome: "WON", oddsScaled: 2000n }]);
    expect(bet.outcome).toBe("WON");
    expect(settlementPayoutMinor(100_000n, bet)).toBe(200_000n);
  });

  it("loses the whole accumulator on one losing leg", () => {
    const bet = resolveBet([
      { outcome: "WON", oddsScaled: 2000n },
      { outcome: "LOST", oddsScaled: 3000n },
      { outcome: "WON", oddsScaled: 1500n },
    ]);
    expect(bet.outcome).toBe("LOST");
    expect(settlementPayoutMinor(100_000n, bet)).toBe(0n);
  });

  // The Phase 4 void rule: the leg rides at 1.0, the rest of the bet stands.
  it("recalculates an accumulator with a void leg at odds 1.0", () => {
    const bet = resolveBet([
      { outcome: "WON", oddsScaled: 2000n },
      { outcome: "VOID", oddsScaled: 3000n },
      { outcome: "WON", oddsScaled: 1500n },
    ]);
    expect(bet.outcome).toBe("WON");
    // 2.0 * 1.5 = 3.0, not 2.0 * 3.0 * 1.5 = 9.0.
    expect(bet.winningLegCount).toBe(2);
    expect(settlementPayoutMinor(100_000n, bet)).toBe(300_000n);
  });

  it("voids the bet and returns the stake when every leg is void", () => {
    const bet = resolveBet([
      { outcome: "VOID", oddsScaled: 2000n },
      { outcome: "VOID", oddsScaled: 3000n },
    ]);
    expect(bet.outcome).toBe("VOID");
    expect(settlementPayoutMinor(100_000n, bet)).toBe(100_000n);
  });

  it("prefers LOST over VOID when the bet both lost and had a void leg", () => {
    // A void leg cannot rescue an accumulator that already contains a loser.
    const bet = resolveBet([
      { outcome: "VOID", oddsScaled: 2000n },
      { outcome: "LOST", oddsScaled: 3000n },
    ]);
    expect(bet.outcome).toBe("LOST");
  });

  it("keeps the void-leg payout exact rather than drifting through floats", () => {
    const bet = resolveBet([
      { outcome: "WON", oddsScaled: 1010n },
      { outcome: "VOID", oddsScaled: 5000n },
      { outcome: "WON", oddsScaled: 1010n },
      { outcome: "WON", oddsScaled: 1010n },
    ]);
    expect(bet.outcome).toBe("WON");
    // Folding leg-by-leg with a division each time collapses 1.010^3 to
    // 1.030 and shorts the user 301 kobo. One division at the end is exact.
    expect(settlementPayoutMinor(1_000_000n, bet)).toBe(1_030_301n);
  });
});

/**
 * The property that ties Phase 3 to Phase 4.
 *
 * A user is quoted potential_return_minor at placement. If every leg wins,
 * settlement must pay that number back exactly — not one kobo more or less.
 * Placement and settlement compute it through different code paths, so this
 * is where a divergence between them would show up.
 */
describe("placement and settlement agree", () => {
  const oddsArb = fc.integer({ min: 1001, max: 20_000 }).map((v) => BigInt(v));
  const stakeArb = fc.integer({ min: 1_000, max: 50_000_000 }).map((v) => BigInt(v));

  it("pays exactly the quoted return when every leg wins", () => {
    fc.assert(
      fc.property(fc.array(oddsArb, { minLength: 1, maxLength: 6 }), stakeArb, (legs, stake) => {
        const quoted = priceBet(legs, stake).potentialReturnMinor;
        const settled = settlementPayoutMinor(
          stake,
          resolveBet(legs.map((oddsScaled) => ({ outcome: "WON" as const, oddsScaled }))),
        );
        expect(settled).toBe(quoted);
      }),
      { numRuns: 500 },
    );
  });

  it("never pays a winning bet less than the stake", () => {
    fc.assert(
      fc.property(fc.array(oddsArb, { minLength: 1, maxLength: 6 }), stakeArb, (legs, stake) => {
        const resolution = resolveBet(
          legs.map((oddsScaled) => ({ outcome: "WON" as const, oddsScaled })),
        );
        expect(settlementPayoutMinor(stake, resolution) >= stake).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
