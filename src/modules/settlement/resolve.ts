import type { MarketKey } from "@/modules/odds/canonical";

/**
 * Pure settlement rules: given a market, a selection key, and a match result,
 * decide whether that leg won, lost, or is void.
 *
 * No database, no clock, no I/O — a lab auditor can read these functions and
 * reproduce any historical payout by hand, which is what GLI-33 asks for.
 *
 * THE RULE THAT COSTS THE MOST MONEY IF WRONG (invariant 10): match-result
 * markets settle against the REGULATION score (`ft`), never the
 * penalty/extra-time-inclusive final. A cup tie won 4-2 on penalties after a
 * 1-1 draw is a DRAW for 1X2, double chance, correct score and BTTS. Settling
 * those against the trophy-winner pays the wrong side on every knockout tie.
 */

export type LegOutcome = "WON" | "LOST" | "VOID";

export interface PeriodScore {
  home: number;
  away: number;
}

export interface MatchResult {
  /** SETTLED means the match was played to a result; CANCELLED voids it. */
  status: "SETTLED" | "CANCELLED";
  /** p1, p2, ft, ot, ap — see the provider contract. */
  periods: Record<string, PeriodScore>;
}

/**
 * Raised when a leg cannot be settled from the data available.
 *
 * Deliberately fatal rather than defaulting to LOST. A missing period or an
 * unsupported line means we do not know the answer, and guessing is how a
 * book pays the wrong side quietly. The bet stays PENDING and a human looks.
 */
export class UnsettleableError extends Error {
  constructor(
    readonly marketKey: string,
    readonly selectionKey: string,
    readonly reason: string,
  ) {
    super(`cannot settle ${marketKey}/${selectionKey}: ${reason}`);
    this.name = "UnsettleableError";
  }
}

/** Regulation-time score. Everything except ht_ft settles against this. */
function regulation(result: MatchResult, market: string, selection: string): PeriodScore {
  const ft = result.periods.ft;
  if (!ft) throw new UnsettleableError(market, selection, "no regulation (ft) score");
  return ft;
}

function halfTime(result: MatchResult, market: string, selection: string): PeriodScore {
  const p1 = result.periods.p1;
  if (!p1) throw new UnsettleableError(market, selection, "no half-time (p1) score");
  return p1;
}

function won(condition: boolean): LegOutcome {
  return condition ? "WON" : "LOST";
}

/** 1X2 outcome of a score, in the canonical selection vocabulary. */
function outcomeOf(score: PeriodScore): "home" | "draw" | "away" {
  if (score.home > score.away) return "home";
  if (score.home < score.away) return "away";
  return "draw";
}

/**
 * Parses a NUMERIC(6,2) line into hundredths.
 *
 * Integer maths for the same reason pricing uses it: comparing a float line
 * against a goal total invites 2.5 !== 2.5 surprises at the boundary, and the
 * boundary is exactly where pushes live.
 */
function parseLineToHundredths(line: string | null, market: string, selection: string): bigint {
  if (line === null || line.trim() === "") {
    throw new UnsettleableError(market, selection, "market line is missing");
  }
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(line.trim());
  if (!match) throw new UnsettleableError(market, selection, `unreadable line "${line}"`);
  const [, sign, whole, fraction = ""] = match;
  const scaled = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return sign === "-" ? -scaled : scaled;
}

/**
 * Quarter lines (.25/.75) split the stake across two handicaps and settle as
 * a half-win/half-loss. That is a different payout shape than WON|LOST|VOID
 * can express, so we refuse them rather than rounding to the nearest whole
 * outcome and paying the wrong amount. Ingestion may surface them later; the
 * settlement model has to grow first.
 */
function assertSettleableLine(hundredths: bigint, market: string, selection: string): void {
  const remainder = ((hundredths % 100n) + 100n) % 100n;
  if (remainder !== 0n && remainder !== 50n) {
    throw new UnsettleableError(
      market,
      selection,
      `quarter lines are not supported (${Number(hundredths) / 100})`,
    );
  }
}

function resolveOneXTwo(selection: string, score: PeriodScore, market: string): LegOutcome {
  if (selection !== "home" && selection !== "draw" && selection !== "away") {
    throw new UnsettleableError(market, selection, "unknown selection key");
  }
  return won(outcomeOf(score) === selection);
}

function resolveDoubleChance(selection: string, score: PeriodScore, market: string): LegOutcome {
  const actual = outcomeOf(score);
  switch (selection) {
    case "home_or_draw":
      return won(actual === "home" || actual === "draw");
    case "home_or_away":
      return won(actual === "home" || actual === "away");
    case "draw_or_away":
      return won(actual === "draw" || actual === "away");
    default:
      throw new UnsettleableError(market, selection, "unknown selection key");
  }
}

function resolveOverUnder(
  selection: string,
  line: string | null,
  score: PeriodScore,
  market: string,
): LegOutcome {
  const hundredths = parseLineToHundredths(line, market, selection);
  assertSettleableLine(hundredths, market, selection);

  const totalHundredths = BigInt(score.home + score.away) * 100n;

  // A whole line landed on exactly: stake returned, nobody wins.
  if (totalHundredths === hundredths) return "VOID";

  if (selection.startsWith("over_")) return won(totalHundredths > hundredths);
  if (selection.startsWith("under_")) return won(totalHundredths < hundredths);
  throw new UnsettleableError(market, selection, "unknown selection key");
}

function resolveBtts(selection: string, score: PeriodScore, market: string): LegOutcome {
  const both = score.home > 0 && score.away > 0;
  if (selection === "yes") return won(both);
  if (selection === "no") return won(!both);
  throw new UnsettleableError(market, selection, "unknown selection key");
}

function resolveHandicap(
  selection: string,
  line: string | null,
  score: PeriodScore,
  market: string,
): LegOutcome {
  const hundredths = parseLineToHundredths(line, market, selection);
  assertSettleableLine(hundredths, market, selection);

  const home = BigInt(score.home) * 100n;
  const away = BigInt(score.away) * 100n;

  // The line is expressed from the named side's point of view and added to
  // that side's score, so home_-1.5 means "home must win by two or more".
  let adjustedDifference: bigint;
  if (selection.startsWith("home_")) {
    adjustedDifference = home + hundredths - away;
  } else if (selection.startsWith("away_")) {
    adjustedDifference = away + hundredths - home;
  } else {
    throw new UnsettleableError(market, selection, "unknown selection key");
  }

  if (adjustedDifference === 0n) return "VOID"; // whole-line push
  return won(adjustedDifference > 0n);
}

function resolveCorrectScore(selection: string, score: PeriodScore, market: string): LegOutcome {
  if (selection === "other") {
    // "Any other score" is only settleable against the enumerated scorelines
    // the market actually offered, which this function does not see. Refusing
    // is correct: the alternative is paying it as a loser on every match.
    throw new UnsettleableError(market, selection, "'other' needs the market's full scoreline set");
  }
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(selection);
  if (!match) throw new UnsettleableError(market, selection, "unknown selection key");
  return won(Number(match[1]) === score.home && Number(match[2]) === score.away);
}

function resolveHtFt(
  selection: string,
  half: PeriodScore,
  full: PeriodScore,
  market: string,
): LegOutcome {
  const parts = selection.split("/");
  if (parts.length !== 2) throw new UnsettleableError(market, selection, "unknown selection key");
  const [wantHalf, wantFull] = parts;
  const valid = new Set(["home", "draw", "away"]);
  if (!valid.has(wantHalf!) || !valid.has(wantFull!)) {
    throw new UnsettleableError(market, selection, "unknown selection key");
  }
  return won(outcomeOf(half) === wantHalf && outcomeOf(full) === wantFull);
}

/**
 * Resolves one bet leg.
 *
 * `line` is the selection's stored line (NUMERIC text) and is required for
 * over/under and handicap.
 */
export function resolveLeg(
  marketKey: MarketKey,
  selectionKey: string,
  line: string | null,
  result: MatchResult,
): LegOutcome {
  // An abandoned or cancelled match voids every leg on it regardless of
  // whatever partial score was recorded before it stopped.
  if (result.status === "CANCELLED") return "VOID";

  switch (marketKey) {
    case "1x2":
      return resolveOneXTwo(selectionKey, regulation(result, marketKey, selectionKey), marketKey);
    case "double_chance":
      return resolveDoubleChance(
        selectionKey,
        regulation(result, marketKey, selectionKey),
        marketKey,
      );
    case "over_under":
      return resolveOverUnder(
        selectionKey,
        line,
        regulation(result, marketKey, selectionKey),
        marketKey,
      );
    case "btts":
      return resolveBtts(selectionKey, regulation(result, marketKey, selectionKey), marketKey);
    case "handicap":
      return resolveHandicap(
        selectionKey,
        line,
        regulation(result, marketKey, selectionKey),
        marketKey,
      );
    case "correct_score":
      return resolveCorrectScore(
        selectionKey,
        regulation(result, marketKey, selectionKey),
        marketKey,
      );
    case "ht_ft":
      return resolveHtFt(
        selectionKey,
        halfTime(result, marketKey, selectionKey),
        regulation(result, marketKey, selectionKey),
        marketKey,
      );
    default: {
      const exhaustive: never = marketKey;
      throw new UnsettleableError(String(exhaustive), selectionKey, "unsupported market");
    }
  }
}

export type BetOutcome = "WON" | "LOST" | "VOID";

export interface BetResolution {
  outcome: BetOutcome;
  /**
   * RAW product of the winning legs' scaled odds — deliberately not reduced
   * back to a single scale-1000 value here.
   *
   * Dividing after each leg truncates repeatedly: three legs at 1.010 fold to
   * 1.030 instead of 1.030301, and the user is short 301 kobo per ₦10,000.
   * The divisor is applied once, in settlementPayoutMinor, which is also what
   * makes an all-won bet pay exactly the potential_return_minor computed at
   * placement — the two formulas are then identical.
   */
  winningOddsProductScaled: bigint;
  /** Number of legs in that product; the exponent of the single divisor. */
  winningLegCount: number;
}

const ODDS_SCALE = 1000n;

/**
 * Folds resolved legs into the bet's outcome and the odds it actually pays at.
 *
 * A void leg does not kill an accumulator — it drops to odds 1.0 and the rest
 * of the bet stands. All legs void means the whole bet is void and the stake
 * comes back.
 */
export function resolveBet(
  legs: readonly { outcome: LegOutcome; oddsScaled: bigint }[],
): BetResolution {
  if (legs.length === 0) throw new RangeError("a bet needs at least one leg");

  // One losing leg is enough: the accumulator is dead regardless of the rest,
  // and it pays nothing, so the odds are irrelevant.
  if (legs.some((leg) => leg.outcome === "LOST")) {
    return { outcome: "LOST", winningOddsProductScaled: 1n, winningLegCount: 0 };
  }

  if (legs.every((leg) => leg.outcome === "VOID")) {
    return { outcome: "VOID", winningOddsProductScaled: 1n, winningLegCount: 0 };
  }

  let winningOddsProductScaled = 1n;
  let winningLegCount = 0;
  for (const leg of legs) {
    if (leg.outcome !== "WON") continue; // void legs ride at 1.000
    winningOddsProductScaled *= leg.oddsScaled;
    winningLegCount += 1;
  }

  return { outcome: "WON", winningOddsProductScaled, winningLegCount };
}

/**
 * What a settled bet pays out, in kobo.
 *
 * WON  — stake x effective odds, floored, matching placement's rounding.
 * VOID — the stake back, exactly.
 * LOST — nothing.
 */
export function settlementPayoutMinor(
  stakeMinor: bigint,
  resolution: BetResolution,
): bigint {
  switch (resolution.outcome) {
    case "LOST":
      return 0n;
    case "VOID":
      return stakeMinor;
    case "WON":
      // One division, at the end — the same shape as priceBet, so a bet with
      // no void legs settles for exactly the payout quoted at placement.
      return (
        (stakeMinor * resolution.winningOddsProductScaled) /
        ODDS_SCALE ** BigInt(resolution.winningLegCount)
      );
  }
}
