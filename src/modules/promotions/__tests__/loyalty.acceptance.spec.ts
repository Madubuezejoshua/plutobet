import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { nextTier, pointsForStake, tierFor, TIERS } from "../loyalty.service";

describe("loyalty tiers", () => {
  it("awards one point per whole naira staked", () => {
    expect(pointsForStake(10_000n)).toBe(100n);
    expect(pointsForStake(150n)).toBe(1n);
  });

  /*
   * Truncating rather than rounding up. Rounding a 50-kobo stake to a point
   * would let someone farm the ladder with tiny bets, which measures
   * persistence rather than turnover.
   */
  it("does not round a part-naira stake up to a point", () => {
    expect(pointsForStake(99n)).toBe(0n);
    expect(pointsForStake(0n)).toBe(0n);
  });

  it("places every point total in exactly one tier", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000_000n }), (points) => {
        const tier = tierFor(points);
        expect(points).toBeGreaterThanOrEqual(tier.threshold);

        const higher = TIERS.filter((t) => t.threshold > tier.threshold);
        for (const candidate of higher) {
          expect(points).toBeLessThan(candidate.threshold);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("starts everyone at the bottom rung", () => {
    expect(tierFor(0n).key).toBe("BRONZE");
  });

  it("promotes exactly at the threshold, not one point after", () => {
    for (const tier of TIERS) {
      expect(tierFor(tier.threshold).key).toBe(tier.key);
      if (tier.threshold > 0n) {
        expect(tierFor(tier.threshold - 1n).key).not.toBe(tier.key);
      }
    }
  });

  it("never suggests a next tier at the top", () => {
    const top = TIERS.at(-1)!;
    expect(nextTier(top.threshold)).toBeNull();
    expect(nextTier(top.threshold * 10n)).toBeNull();
  });

  it("always points upward when there is somewhere to go", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 4_999_999n }), (points) => {
        const next = nextTier(points);
        expect(next).not.toBeNull();
        expect(next!.threshold).toBeGreaterThan(points);
      }),
      { numRuns: 300 },
    );
  });
});
