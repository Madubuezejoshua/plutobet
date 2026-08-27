import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computePool, splitPool } from "../jackpot.service";

/**
 * Pool arithmetic.
 *
 * Two properties carry all the weight, and both are about money not going
 * missing: the operator's margin plus the pool must equal exactly what was
 * collected, and the shares paid out must equal exactly the pool.
 */
describe("prize pool", () => {
  it("splits fees between pool and margin at the stated rate", () => {
    const pool = computePool({
      entries: 100,
      entryFeeMinor: 10_000n, // ₦100
      poolContributionBasisPoints: 7000, // 70%
      guaranteedPrizeMinor: 0n,
    });

    expect(pool.grossFeesMinor).toBe(1_000_000n);
    expect(pool.poolMinor).toBe(700_000n);
    expect(pool.marginMinor).toBe(300_000n);
  });

  it("adds the guarantee on top of the entry contribution", () => {
    const pool = computePool({
      entries: 10,
      entryFeeMinor: 10_000n,
      poolContributionBasisPoints: 7000,
      guaranteedPrizeMinor: 500_000n,
    });
    // 70,000 from entries plus the 500,000 guarantee.
    expect(pool.poolMinor).toBe(570_000n);
  });

  it("still pays the guarantee when nobody entered", () => {
    const pool = computePool({
      entries: 0,
      entryFeeMinor: 10_000n,
      poolContributionBasisPoints: 7000,
      guaranteedPrizeMinor: 500_000n,
    });
    expect(pool.grossFeesMinor).toBe(0n);
    expect(pool.poolMinor).toBe(500_000n);
  });

  /*
   * The margin is derived by SUBTRACTION rather than rounded separately.
   * Rounding both halves independently is how a pool ends up a kobo short of
   * the fees collected.
   */
  it("never loses or invents a kobo between pool and margin", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        (entries, fee, basisPoints) => {
          const pool = computePool({
            entries,
            entryFeeMinor: fee,
            poolContributionBasisPoints: basisPoints,
            guaranteedPrizeMinor: 0n,
          });
          expect(pool.poolMinor + pool.marginMinor).toBe(pool.grossFeesMinor);
          expect(pool.marginMinor).toBeGreaterThanOrEqual(0n);
          expect(pool.poolMinor).toBeGreaterThanOrEqual(0n);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("splitting a pool between winners", () => {
  it("divides evenly when it can", () => {
    expect(splitPool(300_000n, 3)).toEqual([100_000n, 100_000n, 100_000n]);
  });

  /*
   * Integer division leaves a remainder of up to (winners - 1) kobo. A house
   * that silently pockets it on every jackpot is taking money nobody agreed
   * to, so it is distributed a kobo at a time.
   */
  it("distributes the remainder rather than keeping it", () => {
    const shares = splitPool(100n, 3);
    expect(shares).toEqual([34n, 33n, 33n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n);
  });

  it("always pays out exactly the pool", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 500 }),
        (pool, winners) => {
          const shares = splitPool(pool, winners);
          expect(shares).toHaveLength(winners);
          expect(shares.reduce((a, b) => a + b, 0n)).toBe(pool);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never differs between winners by more than a kobo", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 200 }),
        (pool, winners) => {
          const shares = splitPool(pool, winners);
          const min = shares.reduce((a, b) => (b < a ? b : a));
          const max = shares.reduce((a, b) => (b > a ? b : a));
          expect(max - min).toBeLessThanOrEqual(1n);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("pays nothing when there are no winners", () => {
    expect(splitPool(500_000n, 0)).toEqual([]);
  });

  it("is deterministic, so a replayed settlement pays the same amounts", () => {
    expect(splitPool(1_000_001n, 7)).toEqual(splitPool(1_000_001n, 7));
  });
});
