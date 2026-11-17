/**
 * System bets, bankers, and the combinations they expand into.
 *
 * WHAT A SYSTEM BET IS
 * From N selections, back every possible combination of size k. A "2/3" backs
 * all three pairs from three selections, so one losing leg still leaves a
 * winning pair. It is an accumulator that does not die on the first upset,
 * paid for by staking the combination count rather than once.
 *
 * BANKERS
 * A banker appears in EVERY combination. With B bankers, each combination is
 * the B bankers plus (k - B) of the remaining (N - B) selections, so the count
 * is C(N-B, k-B) rather than C(N, k). A banker that loses takes the whole slip
 * with it — which is the point: it is the selection you are certain of, traded
 * for a much smaller stake.
 *
 * HOW THIS IS REPRESENTED DOWNSTREAM
 * Each combination becomes an ORDINARY accumulator bet row. A 2/3 system is
 * three bets on one slip.
 *
 * That choice is the whole reason this phase is small. Settlement, exposure,
 * cash-out, the statement and every money invariant already handle an
 * accumulator correctly and are heavily tested; expanding a system into
 * accumulators means none of them need to learn what a system is. The
 * alternative — one row carrying a system, with settlement computing partial
 * outcomes across combinations — would have put new logic inside the most
 * dangerous code in the product.
 *
 * It is the same trade as modelling wallet buckets as wallet rows in phase 4,
 * for the same reason: reuse the machinery that is already proven.
 */

export class SystemBetError extends Error {
  constructor(
    readonly code:
      | "TOO_FEW_SELECTIONS"
      | "INVALID_SIZE"
      | "TOO_MANY_BANKERS"
      | "TOO_MANY_COMBINATIONS",
    message: string,
  ) {
    super(message);
    this.name = "SystemBetError";
  }
}

/**
 * Most combinations one slip may expand into.
 *
 * C(20,10) is 184,756. Each combination is a real bet row with a real ledger
 * leg and real exposure, so an uncapped system is a denial-of-service against
 * our own database that the customer pays for. A thousand is far beyond any
 * genuine slip and keeps the placement transaction bounded.
 */
export const MAX_COMBINATIONS = 1000;

/** Matches the placement service's accumulator ceiling. */
export const MAX_SELECTIONS = 20;

export interface SystemShape {
  /** Total selections on the slip. */
  selectionCount: number;
  /** Combination size, counting bankers. */
  systemSize: number;
  /** Indices (into the selection list) that must appear in every combination. */
  bankerIndices: number[];
}

/**
 * C(n, k), computed without overflowing or losing precision.
 *
 * Multiplies and divides alternately so the running value stays an exact
 * integer at every step and never grows to n!. Computing factorials
 * separately would overflow Number well before n = 20 and silently return a
 * wrong count — which here would mean charging the wrong stake.
 */
export function combinationCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;

  // C(n,k) === C(n,n-k); taking the smaller keeps the loop short.
  const smaller = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= smaller; index += 1) {
    // Exact at every step: the product of `index` consecutive integers is
    // always divisible by index!.
    result = (result * (n - smaller + index)) / index;
  }
  return Math.round(result);
}

/**
 * Validates a system shape and returns how many bets it produces.
 *
 * Throws rather than clamping. A slip that silently became a different bet
 * than the customer chose is worse than one that was refused.
 */
export function describeSystem(shape: SystemShape): {
  combinations: number;
  freeSlots: number;
  poolSize: number;
} {
  const { selectionCount, systemSize, bankerIndices } = shape;
  const bankers = new Set(bankerIndices).size;

  if (selectionCount < 2) {
    throw new SystemBetError("TOO_FEW_SELECTIONS", "a system needs at least two selections");
  }
  if (selectionCount > MAX_SELECTIONS) {
    throw new SystemBetError(
      "TOO_FEW_SELECTIONS",
      `a slip may hold at most ${MAX_SELECTIONS} selections`,
    );
  }
  if (systemSize < 1 || systemSize > selectionCount) {
    throw new SystemBetError(
      "INVALID_SIZE",
      `system size must be between 1 and ${selectionCount}`,
    );
  }
  if (bankers > systemSize) {
    // More bankers than places in a combination is not expressible: every
    // banker must fit in every combination.
    throw new SystemBetError(
      "TOO_MANY_BANKERS",
      "there cannot be more bankers than the system size",
    );
  }
  if (bankers >= selectionCount) {
    throw new SystemBetError(
      "TOO_MANY_BANKERS",
      "at least one selection must not be a banker",
    );
  }

  // Bankers occupy their slot in every combination, so the choosing happens
  // over what is left.
  const poolSize = selectionCount - bankers;
  const freeSlots = systemSize - bankers;
  const combinations = combinationCount(poolSize, freeSlots);

  if (combinations === 0) {
    throw new SystemBetError("INVALID_SIZE", "that system produces no combinations");
  }
  if (combinations > MAX_COMBINATIONS) {
    throw new SystemBetError(
      "TOO_MANY_COMBINATIONS",
      `that system produces ${combinations} bets; the maximum is ${MAX_COMBINATIONS}`,
    );
  }

  return { combinations, freeSlots, poolSize };
}

/**
 * Expands a system into the exact leg-index sets to be placed.
 *
 * Returned in a stable, sorted order so the same slip always produces the same
 * bets in the same sequence — which makes a placement idempotent on replay and
 * makes a support conversation about "the third combination" meaningful.
 */
export function expandSystem(shape: SystemShape): number[][] {
  const { combinations, freeSlots } = describeSystem(shape);
  const bankers = [...new Set(shape.bankerIndices)].sort((a, b) => a - b);
  const bankerSet = new Set(bankers);

  const pool: number[] = [];
  for (let index = 0; index < shape.selectionCount; index += 1) {
    if (!bankerSet.has(index)) pool.push(index);
  }

  const expanded: number[][] = [];
  const current: number[] = [];

  // Standard lexicographic k-subset walk. Iterative rather than recursive so a
  // wide slip cannot blow the stack.
  const choose = (start: number): void => {
    if (current.length === freeSlots) {
      expanded.push([...bankers, ...current].sort((a, b) => a - b));
      return;
    }
    // Stop early once too few candidates remain to complete a combination.
    for (let index = start; index <= pool.length - (freeSlots - current.length); index += 1) {
      current.push(pool[index]!);
      choose(index + 1);
      current.pop();
    }
  };

  if (freeSlots === 0) {
    // Every banker, no free slots: exactly one combination.
    expanded.push([...bankers]);
  } else {
    choose(0);
  }

  if (expanded.length !== combinations) {
    // The count and the expansion disagreeing means one of them is wrong, and
    // charging a stake based on the wrong one is a money bug.
    throw new Error(
      `system expansion produced ${expanded.length} combinations, expected ${combinations}`,
    );
  }

  return expanded;
}

/**
 * Total stake for a system.
 *
 * Every combination is its own bet at the unit stake, so the customer pays the
 * unit stake once per combination. Stated explicitly because it is the single
 * thing people misread about system bets: a "₦100 2/3" costs ₦300, not ₦100.
 */
export function systemTotalStake(unitStakeMinor: bigint, combinations: number): bigint {
  return unitStakeMinor * BigInt(combinations);
}

/**
 * The named systems a customer recognises.
 *
 * "Cut 1" tolerates one losing leg — mathematically a system of size (N-1)
 * from N. Naming it that way rather than exposing raw k/N is how the products
 * people already know map onto the same engine.
 */
export function namedSystems(selectionCount: number): {
  label: string;
  systemSize: number;
  combinations: number;
}[] {
  if (selectionCount < 2) return [];

  const options: { label: string; systemSize: number; combinations: number }[] = [];

  for (let size = 2; size <= selectionCount; size += 1) {
    const combinations = combinationCount(selectionCount, size);
    if (combinations > MAX_COMBINATIONS) continue;

    const label =
      size === selectionCount
        ? `Accumulator (${size} folds)`
        : size === selectionCount - 1
          ? `Cut 1 — ${size}/${selectionCount}`
          : `${size}/${selectionCount}`;

    options.push({ label, systemSize: size, combinations });
  }

  return options;
}
