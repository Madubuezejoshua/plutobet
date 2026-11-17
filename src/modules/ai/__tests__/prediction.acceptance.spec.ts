import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { describeEstimate, estimateMatch, impliedOdds } from "../prediction";
import { checkForCertaintyClaims } from "../guardrails";
import type { TeamForm } from "../../sports/results.service";

function form(overrides: Partial<TeamForm> = {}): TeamForm {
  return {
    teamId: "t",
    name: "Team",
    form: [],
    played: 6,
    won: 3,
    drawn: 1,
    lost: 2,
    goalsFor: 9,
    goalsAgainst: 7,
    ...overrides,
  };
}

/**
 * Probabilities are computed here rather than produced by a language model,
 * so they are testable. These tests exist because a fabricated probability on
 * a gambling product is an inducement to stake money on a number nobody can
 * check.
 */
describe("match estimation", () => {
  /*
   * The property that carries the most weight. Anything converting these to
   * prices inherits a book that does not balance if they do not sum to one,
   * and that error eventually shows up as money.
   */
  it("always produces three probabilities summing to exactly 1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        (homeWon, awayWon, homeGoals, awayGoals) => {
          const played = 10;
          const result = estimateMatch(
            form({
              name: "Home",
              played,
              won: Math.min(homeWon, played),
              drawn: 0,
              lost: played - Math.min(homeWon, played),
              goalsFor: homeGoals,
              goalsAgainst: awayGoals,
            }),
            form({
              name: "Away",
              played,
              won: Math.min(awayWon, played),
              drawn: 0,
              lost: played - Math.min(awayWon, played),
              goalsFor: awayGoals,
              goalsAgainst: homeGoals,
            }),
          );

          const total = result.home + result.draw + result.away;
          expect(Math.abs(total - 1)).toBeLessThan(1e-9);
          for (const value of [result.home, result.draw, result.away]) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("favours the stronger side", () => {
    const strong = form({ name: "Strong", won: 6, drawn: 0, lost: 0, goalsFor: 15, goalsAgainst: 2 });
    const weak = form({ name: "Weak", won: 0, drawn: 0, lost: 6, goalsFor: 2, goalsAgainst: 15 });

    const result = estimateMatch(strong, weak);
    expect(result.home).toBeGreaterThan(result.away);
    expect(result.home).toBeGreaterThan(0.5);
  });

  it("gives the home side an edge between identical teams", () => {
    const a = form({ name: "A" });
    const b = form({ name: "B" });
    const result = estimateMatch(a, b);
    // Home advantage is the only asymmetry, and it should be visible.
    expect(result.home).toBeGreaterThan(result.away);
  });

  /*
   * Evenly matched sides draw more often than mismatches. A flat draw rate
   * would systematically misprice exactly the fixtures people bet on most.
   */
  it("predicts more draws between evenly matched teams", () => {
    const even = estimateMatch(form({ name: "A" }), form({ name: "B" }));
    const mismatch = estimateMatch(
      form({ name: "Strong", won: 6, drawn: 0, lost: 0, goalsFor: 18, goalsAgainst: 1 }),
      form({ name: "Weak", won: 0, drawn: 0, lost: 6, goalsFor: 1, goalsAgainst: 18 }),
    );
    expect(even.draw).toBeGreaterThan(mismatch.draw);
  });

  describe("honesty about evidence", () => {
    it("reports low confidence on a thin sample", () => {
      const result = estimateMatch(
        form({ name: "A", played: 2, won: 1, drawn: 0, lost: 1, goalsFor: 2, goalsAgainst: 2 }),
        form({ name: "B", played: 2, won: 1, drawn: 0, lost: 1, goalsFor: 2, goalsAgainst: 2 }),
      );
      expect(result.confidence).toBe("LOW");
      expect(result.sampleSize).toBe(2);
      // Said out loud, not just encoded in an enum somebody ignores.
      expect(result.factors.join(" ")).toMatch(/weak evidence/i);
    });

    it("reports high confidence only with a real sample", () => {
      const result = estimateMatch(
        form({ name: "A", played: 12 }),
        form({ name: "B", played: 12 }),
      );
      expect(result.confidence).toBe("HIGH");
    });

    it("refuses to differentiate two teams with no history", () => {
      const result = estimateMatch(
        form({ name: "A", played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0 }),
        form({ name: "B", played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0 }),
      );
      expect(result.confidence).toBe("LOW");
      expect(Math.abs(result.home + result.draw + result.away - 1)).toBeLessThan(1e-9);
    });
  });

  describe("implied odds", () => {
    it("inverts a probability into a fair price", () => {
      expect(impliedOdds(0.5)).toBe(2);
      expect(impliedOdds(0.25)).toBe(4);
    });

    it("refuses a probability that is not a probability", () => {
      // A price for a certainty does not exist, and 1/0 is not an answer.
      expect(impliedOdds(0)).toBeNull();
      expect(impliedOdds(1)).toBeNull();
      expect(impliedOdds(-0.5)).toBeNull();
    });
  });

  /*
   * Rule 15 end to end: the text this produces must never read as a certainty,
   * whatever the numbers are.
   */
  it("never describes an estimate in language that implies certainty", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (won) => {
        const result = estimateMatch(
          form({ name: "Arsenal", played: 20, won, drawn: 0, lost: 20 - won }),
          form({ name: "Chelsea", played: 20, won: 20 - won, drawn: 0, lost: won }),
        );
        const text = describeEstimate(result, "Arsenal", "Chelsea");
        expect(checkForCertaintyClaims(text).safe).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("always states its own confidence in the description", () => {
    const text = describeEstimate(
      estimateMatch(form({ name: "A" }), form({ name: "B" })),
      "A",
      "B",
    );
    expect(text).toMatch(/Confidence:/);
    expect(text).toMatch(/recent matches/);
  });
});
