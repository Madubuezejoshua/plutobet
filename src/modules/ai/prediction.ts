/**
 * Match probability estimation.
 *
 * RULE 18, AND THE REASON THIS IS NOT AN LLM PROMPT
 * "Do NOT let the conversational LLM simply invent predictions."
 *
 * A language model asked "who wins?" produces a confident-sounding number with
 * no relationship to anything. It cannot be audited, it is not reproducible,
 * and on a gambling product it is a fabricated inducement to stake money. So
 * probabilities are computed HERE, from recorded results, by arithmetic anyone
 * can check — and the model's only job is to read the output aloud.
 *
 * WHAT THIS IS
 * A deliberately simple form-and-home-advantage model. It is not sophisticated
 * and does not pretend to be: it is transparent, reproducible, and honest about
 * its own uncertainty, which matters more here than accuracy. A model nobody
 * can explain has no business setting an expectation somebody bets against.
 *
 * WHAT THIS IS NOT
 * A prediction. It is an estimate conditioned on a small sample, and every
 * output carries the sample size so a caller can see how thin the evidence is.
 */

import type { TeamForm } from "../sports/results.service";

export interface MatchProbabilities {
  home: number;
  draw: number;
  away: number;
  /** Matches the estimate is built from. Small means "barely evidence". */
  sampleSize: number;
  /** LOW / MEDIUM / HIGH, derived from sample size alone. */
  confidence: "LOW" | "MEDIUM" | "HIGH";
  /** Plain-language points a person can check against the same data. */
  factors: string[];
}

/**
 * Home advantage, as a share of a match's expected points.
 *
 * Roughly what league tables show across most competitions. Stated as one
 * named constant rather than sprinkled through the arithmetic, so it can be
 * argued with.
 */
const HOME_ADVANTAGE = 0.15;

/** Draws sit around a quarter of football results; the model starts there. */
const BASE_DRAW_RATE = 0.26;

/**
 * Points per match from recent form, on 0-1.
 *
 * Three for a win, one for a draw, over three per match — the ordinary league
 * scale, normalised.
 */
function formStrength(form: TeamForm): number {
  if (form.played === 0) return 0.5; // no evidence: assume average
  const points = form.won * 3 + form.drawn;
  return points / (form.played * 3);
}

/**
 * Goal difference per match, squashed into 0-1.
 *
 * A team winning by three every week is stronger than one scraping 1-0, and
 * form alone cannot see that. The tanh keeps a freak 7-0 from dominating the
 * estimate — the squashing is the point, not a detail.
 */
function scoringStrength(form: TeamForm): number {
  if (form.played === 0) return 0.5;
  const perMatch = (form.goalsFor - form.goalsAgainst) / form.played;
  return 0.5 + Math.tanh(perMatch / 3) / 2;
}

function confidenceFor(sampleSize: number): MatchProbabilities["confidence"] {
  if (sampleSize >= 10) return "HIGH";
  if (sampleSize >= 5) return "MEDIUM";
  return "LOW";
}

/**
 * Estimates 1X2 probabilities from both teams' recent form.
 *
 * The three always sum to exactly 1, which is not cosmetic: a caller
 * converting these to prices would otherwise produce a book that does not
 * balance, and the error would show up as money.
 */
export function estimateMatch(home: TeamForm, away: TeamForm): MatchProbabilities {
  const sampleSize = Math.min(home.played, away.played);

  // Form and scoring weighted 60/40. Form is the stronger signal; goal
  // difference distinguishes teams on equal points.
  const homeStrength = formStrength(home) * 0.6 + scoringStrength(home) * 0.4 + HOME_ADVANTAGE;
  const awayStrength = formStrength(away) * 0.6 + scoringStrength(away) * 0.4;

  const total = homeStrength + awayStrength;
  // Both sides with no history at all: refuse to differentiate rather than
  // divide by zero or invent an edge.
  const homeShare = total === 0 ? 0.5 : homeStrength / total;

  /*
   * The draw rate rises as the sides converge. Two evenly matched teams draw
   * far more often than a mismatch, and a model that used a flat draw rate
   * would systematically misprice exactly the fixtures people bet on most.
   */
  const gap = Math.abs(homeShare - 0.5) * 2;
  const drawProbability = BASE_DRAW_RATE * (1 - gap * 0.6);
  const decisive = 1 - drawProbability;

  const homeProbability = decisive * homeShare;
  const awayProbability = decisive * (1 - homeShare);

  const factors: string[] = [];
  if (home.played > 0) {
    factors.push(`${home.name} form: ${home.form.slice(0, 5).join("") || "none"}`);
  }
  if (away.played > 0) {
    factors.push(`${away.name} form: ${away.form.slice(0, 5).join("") || "none"}`);
  }
  factors.push("Home advantage applied");
  if (sampleSize < 5) {
    // Said out loud rather than buried in a confidence enum somebody ignores.
    factors.push(`Only ${sampleSize} recent matches to go on — treat this as weak evidence`);
  }

  return {
    ...normalise(homeProbability, drawProbability, awayProbability),
    sampleSize,
    confidence: confidenceFor(sampleSize),
    factors,
  };
}

/**
 * Forces the three to sum to exactly 1.
 *
 * Rounding each independently leaves a total of 0.999 or 1.001, and anything
 * downstream converting them to prices inherits that as a book that does not
 * balance. The largest share absorbs the rounding, so the error lands where it
 * is proportionally smallest.
 */
function normalise(home: number, draw: number, away: number): {
  home: number;
  draw: number;
  away: number;
} {
  const total = home + draw + away;
  if (total <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };

  const rounded = {
    home: Math.round((home / total) * 1000) / 1000,
    draw: Math.round((draw / total) * 1000) / 1000,
    away: Math.round((away / total) * 1000) / 1000,
  };

  const drift = Math.round((1 - (rounded.home + rounded.draw + rounded.away)) * 1000) / 1000;
  if (drift !== 0) {
    const largest = (["home", "draw", "away"] as const).reduce((best, key) =>
      rounded[key] > rounded[best] ? key : best,
    );
    rounded[largest] = Math.round((rounded[largest] + drift) * 1000) / 1000;
  }

  return rounded;
}

/**
 * The implied fair decimal price for a probability.
 *
 * Exposed so an estimate can be compared against a real price — "the book has
 * this at 2.10, the model implies 2.35" is a far more useful thing to tell
 * somebody than a bare percentage, and it is checkable.
 */
export function impliedOdds(probability: number): number | null {
  if (probability <= 0 || probability >= 1) return null;
  return Math.round((1 / probability) * 100) / 100;
}

/**
 * Renders an estimate as text.
 *
 * Deliberately NOT generated by a language model. The wording is fixed, the
 * disclaimer is always attached, and no phrasing here can be talked into
 * sounding like a certainty.
 */
export function describeEstimate(
  probabilities: MatchProbabilities,
  homeName: string,
  awayName: string,
): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return [
    `${homeName} ${percent(probabilities.home)} · Draw ${percent(probabilities.draw)} · ${awayName} ${percent(probabilities.away)}`,
    `Confidence: ${probabilities.confidence.toLowerCase()} (${probabilities.sampleSize} recent matches)`,
    ...probabilities.factors.map((factor) => `- ${factor}`),
  ].join("\n");
}
