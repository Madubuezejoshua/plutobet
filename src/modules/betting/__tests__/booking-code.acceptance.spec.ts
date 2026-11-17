import { describe, expect, it } from "vitest";
import {
  bookingCodeExpiry,
  BOOKING_CODE_TTL_DAYS,
  generateBookingCode,
  isValidBookingCode,
  normalizeBookingCode,
} from "../booking-code";

describe("booking codes", () => {
  it("generates codes the database constraint accepts", () => {
    for (let index = 0; index < 500; index += 1) {
      const code = generateBookingCode();
      expect(code).toMatch(/^[A-Z0-9]{6,10}$/);
      expect(isValidBookingCode(code)).toBe(true);
    }
  });

  /*
   * These are read aloud and typed from screenshots. Any of 0/O or 1/I/L in
   * the alphabet turns a mistyped character into somebody else's slip rather
   * than a miss.
   */
  it("excludes visually ambiguous characters", () => {
    const codes = Array.from({ length: 500 }, generateBookingCode).join("");
    // The leading P is the deliberate prefix; the body must avoid the rest.
    expect(codes.replace(/P/g, "")).not.toMatch(/[01OIL]/);
  });

  /*
   * Collisions must be at RANDOM-CHANCE level, not zero.
   *
   * This asserted `size === 5000`, which is a birthday-paradox trap: with a
   * 31^6 space (~8.9e8) and 5000 draws, the expected number of collisions is
   * 0.014 and the chance of seeing at least one is about 1.4% PER RUN. So the
   * test failed roughly one run in seventy, for a generator working exactly as
   * designed — and a test that cries wolf at that rate teaches people to
   * re-run CI instead of reading it. It duly failed once here, on a change
   * that had nothing to do with booking codes.
   *
   * The property worth protecting is that the generator is not BIASED. A
   * broken one — a short body, a clustered alphabet, a seeded PRNG — produces
   * collisions in the hundreds or thousands, not one. Allowing three is over
   * two hundred times the expectation and still orders of magnitude below any
   * real defect.
   */
  it("does not repeat more often than chance allows", () => {
    const sample = 5000;
    const codes = new Set(Array.from({ length: sample }, generateBookingCode));
    const collisions = sample - codes.size;
    expect(collisions).toBeLessThanOrEqual(3);
  });

  it("uses the whole alphabet rather than clustering", () => {
    const sample = Array.from({ length: 2000 }, generateBookingCode)
      .map((code) => code.slice(1))
      .join("");
    // 31 usable characters; far below suggests a modulo bias.
    expect(new Set(sample).size).toBeGreaterThanOrEqual(28);
  });

  describe("forgiving what a person typed", () => {
    it.each([
      ["p23456", "P23456"],
      ["  P23456  ", "P23456"],
      ["P-234-56", "P23456"],
      ["p 234 56", "P23456"],
      // A body typed without the prefix still means the code.
      ["234567", "P234567"],
    ])("%s -> %s", (input, expected) => {
      expect(normalizeBookingCode(input)).toBe(expected);
    });

    it("does not invent a code from empty input", () => {
      expect(normalizeBookingCode("")).toBe("");
      expect(normalizeBookingCode("   ")).toBe("");
      expect(isValidBookingCode(normalizeBookingCode(""))).toBe(false);
    });
  });

  describe("rejecting codes that cannot exist", () => {
    it.each([
      ["too short", "PABC"],
      ["too long", "PABCDEFGHIJ"],
      ["ambiguous character", "PABC0DE"],
      ["lowercase after normalising nothing", "pabcdef"],
      ["wrong prefix", "XABCDEF"],
    ])("%s", (_label, code) => {
      expect(isValidBookingCode(code)).toBe(false);
    });
  });

  describe("expiry", () => {
    it("is always in the future, which the CHECK constraint requires", () => {
      const now = new Date("2026-08-27T12:00:00.000Z");
      expect(bookingCodeExpiry(now).getTime()).toBeGreaterThan(now.getTime());
    });

    it("lasts the documented window", () => {
      const now = new Date("2026-08-27T12:00:00.000Z");
      const days = (bookingCodeExpiry(now).getTime() - now.getTime()) / (24 * 60 * 60_000);
      expect(days).toBe(BOOKING_CODE_TTL_DAYS);
    });
  });
});
