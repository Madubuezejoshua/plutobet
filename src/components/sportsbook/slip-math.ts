import {
  describeSystem,
  expandSystem,
  systemTotalStake,
} from "@/modules/betting/system-bet";

/**
 * Betslip arithmetic.
 *
 * Pulled out of the components so it can be tested without a DOM. These
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
 * What a single or accumulator slip is worth.
 *
 * `returnMinor` is GROSS — it includes the stake. `profitMinor` is what the
 * customer actually gains. Both are returned so the UI cannot accidentally
 * label one as the other, which is the single most common way a betslip
 * overstates a win.
 */
export function slipMath(picks: readonly SlipLeg[], stakeMinor: bigint) {
  const totalOdds = picks.reduce((acc, pick) => acc * pick.odds, 1);
  const returnMinor =
    stakeMinor > 0n ? BigInt(Math.round(Number(stakeMinor) * totalOdds)) : 0n;
  const profitMinor = returnMinor > 0n ? returnMinor - stakeMinor : 0n;
  return { totalOdds, returnMinor, profitMinor };
}

export interface SystemSlipPreview {
  valid: boolean;
  error: string | null;
  combinations: number;
  totalStakeMinor: bigint;
  maxReturnMinor: bigint;
  maxProfitMinor: bigint;
  minWinningReturnMinor: bigint;
}

/**
 * Preview arithmetic for Cut-1 and System slips.
 *
 * Every combination is its own real accumulator staked at `unitStakeMinor`,
 * so `totalStakeMinor = unitStakeMinor * combinations`. If all legs win,
 * every combination pays; if only `systemSize` legs win (e.g. one leg cuts
 * on a Cut-1 ticket), the single surviving combination pays at least
 * `minWinningReturnMinor`.
 */
export function systemSlipMath(
  picks: readonly SlipLeg[],
  unitStakeMinor: bigint,
  systemSize: number,
  bankerIndices: number[],
): SystemSlipPreview {
  try {
    const { combinations } = describeSystem({
      selectionCount: picks.length,
      systemSize,
      bankerIndices,
    });
    const totalStakeMinor = systemTotalStake(unitStakeMinor, combinations);
    if (unitStakeMinor <= 0n) {
      return {
        valid: true,
        error: null,
        combinations,
        totalStakeMinor: 0n,
        maxReturnMinor: 0n,
        maxProfitMinor: 0n,
        minWinningReturnMinor: 0n,
      };
    }

    const combos = expandSystem({
      selectionCount: picks.length,
      systemSize,
      bankerIndices,
    });

    let maxReturnMinor = 0n;
    let minWinningReturnMinor: bigint | null = null;
    for (const combo of combos) {
      const odds = combo.reduce((acc, idx) => acc * (picks[idx]?.odds ?? 1), 1);
      const comboReturn = BigInt(Math.round(Number(unitStakeMinor) * odds));
      maxReturnMinor += comboReturn;
      if (minWinningReturnMinor === null || comboReturn < minWinningReturnMinor) {
        minWinningReturnMinor = comboReturn;
      }
    }

    const maxProfitMinor = maxReturnMinor > totalStakeMinor ? maxReturnMinor - totalStakeMinor : 0n;
    return {
      valid: true,
      error: null,
      combinations,
      totalStakeMinor,
      maxReturnMinor,
      maxProfitMinor,
      minWinningReturnMinor: minWinningReturnMinor ?? 0n,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid system configuration",
      combinations: 0,
      totalStakeMinor: 0n,
      maxReturnMinor: 0n,
      maxProfitMinor: 0n,
      minWinningReturnMinor: 0n,
    };
  }
}

export const ACCA_BOOST_MIN_LEG_ODDS = 1.25;

export const ACCA_BOOST_TIERS: readonly { legs: number; percent: number }[] = [
  { legs: 3, percent: 3 },
  { legs: 4, percent: 5 },
  { legs: 5, percent: 10 },
  { legs: 6, percent: 15 },
  { legs: 7, percent: 20 },
  { legs: 8, percent: 25 },
  { legs: 9, percent: 35 },
  { legs: 10, percent: 50 },
] as const;

export interface AccaBoostPreview {
  qualifyingLegs: number;
  currentPercent: number;
  nextTierLegs: number | null;
  nextTierPercent: number | null;
  legsNeededForNext: number;
  /** Progress percentage (0..100) across the tier ladder for the UI meter. */
  progressPercent: number;
  /** Estimated promo bonus on net profit if all qualifying legs win. */
  estimatedBonusMinor: bigint;
}

/**
 * Progressive Accumulator Multi-Boost estimator.
 *
 * Qualifying legs require decimal odds >= 1.25. Bonus is computed strictly on
 * NET PROFIT (returnMinor - stakeMinor) and kept separate from the
 * authoritative settled `returnMinor` returned by `priceBet()`.
 */
export function accaBoostPreview(
  picks: readonly SlipLeg[],
  stakeMinor: bigint,
  returnMinor: bigint,
): AccaBoostPreview {
  const qualifyingLegs = picks.filter((p) => p.odds >= ACCA_BOOST_MIN_LEG_ODDS).length;

  let currentPercent = 0;
  let nextTier: { legs: number; percent: number } | null = null;

  for (const tier of ACCA_BOOST_TIERS) {
    if (qualifyingLegs >= tier.legs) {
      currentPercent = tier.percent;
    } else if (!nextTier) {
      nextTier = tier;
    }
  }

  const maxLegs = ACCA_BOOST_TIERS[ACCA_BOOST_TIERS.length - 1]!.legs;
  const progressPercent = Math.min(100, Math.round((qualifyingLegs / maxLegs) * 100));
  const profitMinor = returnMinor > stakeMinor ? returnMinor - stakeMinor : 0n;
  const estimatedBonusMinor =
    currentPercent > 0 && profitMinor > 0n
      ? (profitMinor * BigInt(currentPercent)) / 100n
      : 0n;

  return {
    qualifyingLegs,
    currentPercent,
    nextTierLegs: nextTier?.legs ?? null,
    nextTierPercent: nextTier?.percent ?? null,
    legsNeededForNext: nextTier ? Math.max(0, nextTier.legs - qualifyingLegs) : 0,
    progressPercent,
    estimatedBonusMinor,
  };
}

