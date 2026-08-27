import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ageInYears,
  assertOldEnough,
  InvalidDateOfBirthError,
  latestEligibleBirthDate,
  MINIMUM_AGE_YEARS,
  UnderageError,
} from "../age";

/**
 * The age gate is the one rule where "close enough" is a licensing failure, so
 * the boundary is tested to the day in both directions.
 */
describe("age verification", () => {
  const NOW = new Date("2026-08-27T12:00:00.000Z");

  describe("the 18th birthday boundary", () => {
    it("admits someone exactly 18 today", () => {
      expect(assertOldEnough("2008-08-27", NOW)).toBe("2008-08-27");
    });

    it("refuses someone who turns 18 tomorrow", () => {
      expect(() => assertOldEnough("2008-08-28", NOW)).toThrow(UnderageError);
    });

    it("admits someone who turned 18 yesterday", () => {
      expect(assertOldEnough("2008-08-26", NOW)).toBe("2008-08-26");
    });

    /*
     * A leap-day birthday is where a naive `elapsed / 365.25 days` calculation
     * goes wrong, and going wrong here means admitting a 17-year-old.
     */
    it("handles a 29 February birthday in a non-leap year", () => {
      const dayBefore = new Date("2026-02-28T12:00:00.000Z");
      const onMar1 = new Date("2026-03-01T12:00:00.000Z");

      expect(() => assertOldEnough("2008-02-29", dayBefore)).toThrow(UnderageError);
      expect(assertOldEnough("2008-02-29", onMar1)).toBe("2008-02-29");
    });
  });

  describe("ageInYears", () => {
    it("does not count a birthday that has not happened this year", () => {
      expect(ageInYears(new Date("2000-12-31T00:00:00Z"), new Date("2026-01-01T00:00:00Z"))).toBe(25);
      expect(ageInYears(new Date("2000-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"))).toBe(26);
    });

    it("never reports an age above the true elapsed years", () => {
      fc.assert(
        fc.property(
          fc.date({ min: new Date("1920-01-01"), max: new Date("2008-01-01"), noInvalidDate: true }),
          (birth) => {
            const age = ageInYears(birth, NOW);
            const elapsedYears = (NOW.getTime() - birth.getTime()) / (365.25 * 24 * 60 * 60_000);
            // Calendar age may trail the fractional figure, never lead it.
            expect(age).toBeLessThanOrEqual(Math.floor(elapsedYears) + 1);
            expect(age).toBeGreaterThanOrEqual(Math.floor(elapsedYears) - 1);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe("rejects input that is not a date", () => {
    it.each([
      ["empty", ""],
      ["wrong shape", "27/08/2008"],
      ["non-existent day", "2026-02-30"],
      ["month 13", "2008-13-01"],
      ["garbage", "not-a-date"],
    ])("%s", (_label, input) => {
      expect(() => assertOldEnough(input, NOW)).toThrow(InvalidDateOfBirthError);
    });

    it("refuses a future date of birth", () => {
      expect(() => assertOldEnough("2027-01-01", NOW)).toThrow(InvalidDateOfBirthError);
    });

    it("refuses an implausibly distant past", () => {
      expect(() => assertOldEnough("1899-12-31", NOW)).toThrow(InvalidDateOfBirthError);
    });
  });

  describe("latestEligibleBirthDate", () => {
    it("is exactly the date that is 18 today", () => {
      expect(latestEligibleBirthDate(NOW)).toBe("2008-08-27");
    });

    /*
     * Regression: 29 February has no counterpart 18 years earlier, and Date
     * rolls the impossible date FORWARD to 1 March — a cutoff one day too
     * young, which the form would then offer and the service would refuse.
     */
    it("rolls a 29 February cutoff back, not forward", () => {
      expect(latestEligibleBirthDate(new Date("2024-02-29T12:00:00.000Z"))).toBe("2006-02-28");
    });

    /*
     * The value fed to the signup input's `max` must never offer a date the
     * service is then going to refuse — otherwise the form looks broken.
     */
    it("always produces a date the service accepts", () => {
      fc.assert(
        fc.property(
          fc.date({ min: new Date("2024-01-01"), max: new Date("2040-12-31"), noInvalidDate: true }),
          (asOf) => {
            const cutoff = latestEligibleBirthDate(asOf);
            expect(assertOldEnough(cutoff, asOf)).toBe(cutoff);
          },
        ),
        { numRuns: 300 },
      );
    });

    it("produces a date that is underage one day later", () => {
      const cutoff = latestEligibleBirthDate(NOW);
      const dayAfter = new Date(`${cutoff}T00:00:00.000Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      const tooYoung = dayAfter.toISOString().slice(0, 10);

      expect(() => assertOldEnough(tooYoung, NOW)).toThrow(UnderageError);
    });
  });

  it("reports the minimum age Nigeria requires", () => {
    expect(MINIMUM_AGE_YEARS).toBe(18);
  });
});
