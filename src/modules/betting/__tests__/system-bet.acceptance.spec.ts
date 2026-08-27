import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  combinationCount,
  describeSystem,
  expandSystem,
  MAX_COMBINATIONS,
  namedSystems,
  systemTotalStake,
  SystemBetError,
} from "../system-bet";

/**
 * A wrong combination count charges the customer the wrong stake, so these are
 * money tests wearing combinatorics clothing.
 */
describe("combinationCount", () => {
  it.each([
    [3, 2, 3],
    [4, 2, 6],
    [4, 3, 4],
    [5, 3, 10],
    [6, 3, 20],
    [10, 5, 252],
    [20, 10, 184_756],
  ])("C(%i,%i) = %i", (n, k, expected) => {
    expect(combinationCount(n, k)).toBe(expected);
  });

  it("handles the degenerate ends", () => {
    expect(combinationCount(5, 0)).toBe(1);
    expect(combinationCount(5, 5)).toBe(1);
    expect(combinationCount(5, 6)).toBe(0);
    expect(combinationCount(5, -1)).toBe(0);
  });

  it("is symmetric", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 20 }), (n, k) => {
        expect(combinationCount(n, k)).toBe(combinationCount(n, n - k));
      }),
      { numRuns: 300 },
    );
  });

  /*
   * The reason this multiplies and divides alternately instead of computing
   * factorials: 20! is far beyond Number's exact integer range, so a
   * factorial-based implementation returns a non-integer and charges a stake
   * nobody can explain.
   */
  it("returns exact integers all the way to the selection limit", () => {
    for (let n = 0; n <= 20; n += 1) {
      for (let k = 0; k <= n; k += 1) {
        const value = combinationCount(n, k);
        expect(Number.isInteger(value), `C(${n},${k}) = ${value}`).toBe(true);
        expect(Number.isSafeInteger(value)).toBe(true);
      }
    }
  });

  it("satisfies Pascal's rule", () => {
    for (let n = 1; n <= 20; n += 1) {
      for (let k = 1; k < n; k += 1) {
        expect(combinationCount(n, k)).toBe(
          combinationCount(n - 1, k - 1) + combinationCount(n - 1, k),
        );
      }
    }
  });
});

describe("expanding a system", () => {
  it("produces every pair of a 2/3", () => {
    const combos = expandSystem({ selectionCount: 3, systemSize: 2, bankerIndices: [] });
    expect(combos).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
  });

  it("produces a single combination for a full accumulator", () => {
    const combos = expandSystem({ selectionCount: 4, systemSize: 4, bankerIndices: [] });
    expect(combos).toEqual([[0, 1, 2, 3]]);
  });

  it("matches the count it promised", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        (selectionCount, size) => {
          const systemSize = Math.min(size, selectionCount);
          const shape = { selectionCount, systemSize, bankerIndices: [] };
          const { combinations } = describeSystem(shape);
          expect(expandSystem(shape)).toHaveLength(combinations);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never repeats a combination and never repeats a leg within one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (selectionCount, size) => {
          const systemSize = Math.min(size, selectionCount);
          const combos = expandSystem({ selectionCount, systemSize, bankerIndices: [] });

          const seen = new Set(combos.map((combo) => combo.join(",")));
          expect(seen.size).toBe(combos.length);

          for (const combo of combos) {
            expect(new Set(combo).size).toBe(combo.length);
            expect(combo).toHaveLength(systemSize);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  describe("bankers", () => {
    /*
     * A banker is in every combination. That is the entire contract, and it is
     * what a customer is paying for when they choose one.
     */
    it("puts the banker in every combination", () => {
      const combos = expandSystem({ selectionCount: 4, systemSize: 2, bankerIndices: [0] });
      expect(combos).toEqual([
        [0, 1],
        [0, 2],
        [0, 3],
      ]);
      for (const combo of combos) expect(combo).toContain(0);
    });

    it("reduces the combination count to C(N-B, k-B)", () => {
      // 5 selections, 3-fold system, 1 banker -> C(4,2) = 6, not C(5,3) = 10.
      const { combinations } = describeSystem({
        selectionCount: 5,
        systemSize: 3,
        bankerIndices: [2],
      });
      expect(combinations).toBe(6);
      expect(combinations).toBe(combinationCount(4, 2));
    });

    it("keeps every banker in every combination under generation", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 9 }),
          fc.integer({ min: 1, max: 2 }),
          (selectionCount, bankerCount) => {
            const bankers = Array.from({ length: bankerCount }, (_, i) => i);
            const systemSize = Math.min(bankerCount + 1, selectionCount - 1);
            if (systemSize < bankerCount) return;

            const combos = expandSystem({
              selectionCount,
              systemSize,
              bankerIndices: bankers,
            });
            for (const combo of combos) {
              for (const banker of bankers) expect(combo).toContain(banker);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it("collapses to one combination when bankers fill every slot", () => {
      const combos = expandSystem({ selectionCount: 4, systemSize: 2, bankerIndices: [0, 1] });
      expect(combos).toEqual([[0, 1]]);
    });

    it("ignores a banker listed twice", () => {
      const combos = expandSystem({ selectionCount: 4, systemSize: 2, bankerIndices: [0, 0] });
      expect(combos).toEqual([
        [0, 1],
        [0, 2],
        [0, 3],
      ]);
    });
  });
});

describe("refusing systems that cannot be placed", () => {
  it("refuses more bankers than the system size", () => {
    expect(() =>
      describeSystem({ selectionCount: 5, systemSize: 2, bankerIndices: [0, 1, 2] }),
    ).toThrow(SystemBetError);
  });

  it("refuses a slip that is all bankers", () => {
    expect(() =>
      describeSystem({ selectionCount: 2, systemSize: 2, bankerIndices: [0, 1] }),
    ).toThrow(/at least one selection must not be a banker/);
  });

  it("refuses a system larger than the slip", () => {
    expect(() =>
      describeSystem({ selectionCount: 3, systemSize: 4, bankerIndices: [] }),
    ).toThrow(SystemBetError);
  });

  it("refuses a single-selection system", () => {
    expect(() =>
      describeSystem({ selectionCount: 1, systemSize: 1, bankerIndices: [] }),
    ).toThrow(/at least two selections/);
  });

  /*
   * Each combination is a real bet row with a real ledger leg and real
   * exposure. An uncapped system is a denial-of-service against our own
   * database that the customer pays for.
   */
  it("refuses a system that would produce too many bets", () => {
    expect(() =>
      describeSystem({ selectionCount: 20, systemSize: 10, bankerIndices: [] }),
    ).toThrow(/maximum is 1000/);
  });

  it("never allows a placement above the cap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (selectionCount, size) => {
          const systemSize = Math.min(size, selectionCount);
          try {
            const { combinations } = describeSystem({
              selectionCount,
              systemSize,
              bankerIndices: [],
            });
            expect(combinations).toBeLessThanOrEqual(MAX_COMBINATIONS);
          } catch (error) {
            expect(error).toBeInstanceOf(SystemBetError);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("what a system costs", () => {
  /*
   * The single thing people misread about system bets. Stating it in a test
   * so it cannot quietly change.
   */
  it("charges the unit stake once per combination", () => {
    // A "100 naira 2/3" costs 300 naira, not 100.
    expect(systemTotalStake(10_000n, 3)).toBe(30_000n);
  });

  it("matches unit stake times combination count for any shape", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 50_000_000n }),
        fc.integer({ min: 1, max: MAX_COMBINATIONS }),
        (unit, combinations) => {
          expect(systemTotalStake(unit, combinations)).toBe(unit * BigInt(combinations));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("named systems", () => {
  it("offers every placeable size for a slip", () => {
    const options = namedSystems(4);
    expect(options.map((option) => option.systemSize)).toEqual([2, 3, 4]);
  });

  it("names the full-cover option an accumulator", () => {
    const options = namedSystems(3);
    expect(options.at(-1)!.label).toMatch(/Accumulator/);
  });

  /*
   * "Cut 1" is the product name people know for a system that survives one
   * losing leg -- mathematically (N-1) from N.
   */
  it("names the one-loss-tolerant option Cut 1", () => {
    const options = namedSystems(5);
    const cut = options.find((option) => option.systemSize === 4);
    expect(cut!.label).toMatch(/Cut 1/);
    expect(cut!.combinations).toBe(5);
  });

  it("offers nothing for a slip too small to system", () => {
    expect(namedSystems(1)).toEqual([]);
    expect(namedSystems(0)).toEqual([]);
  });

  it("never offers an option above the combination cap", () => {
    for (let count = 2; count <= 20; count += 1) {
      for (const option of namedSystems(count)) {
        expect(option.combinations).toBeLessThanOrEqual(MAX_COMBINATIONS);
      }
    }
  });
});
