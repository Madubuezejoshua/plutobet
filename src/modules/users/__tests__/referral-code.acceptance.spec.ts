import { describe, expect, it } from "vitest";
import {
  generateReferralCode,
  isValidReferralCode,
  normalizeReferralCode,
} from "../referral-code";

describe("referral codes", () => {
  it("produces codes the database constraint accepts", () => {
    for (let index = 0; index < 500; index += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(/^[A-Z0-9]{6,12}$/);
      expect(isValidReferralCode(code)).toBe(true);
    }
  });

  /*
   * These are read aloud and typed from screenshots. Any of 0/O or 1/I/L in
   * the alphabet turns into a support ticket the first time somebody's friend
   * mistypes their code.
   */
  it("excludes visually ambiguous characters", () => {
    const codes = Array.from({ length: 500 }, generateReferralCode).join("");
    expect(codes).not.toMatch(/[01OIL]/);
  });

  it("does not repeat within a large sample", () => {
    const codes = new Set(Array.from({ length: 5000 }, generateReferralCode));
    expect(codes.size).toBe(5000);
  });

  it("uses the whole alphabet rather than clustering", () => {
    const sample = Array.from({ length: 2000 }, generateReferralCode).join("");
    const distinct = new Set(sample).size;
    // 31 usable characters; anything far below suggests a modulo bias.
    expect(distinct).toBeGreaterThanOrEqual(28);
  });

  describe("normalizing what a person typed", () => {
    it.each([
      ["  abc123  ", "ABC123"],
      ["abc-123", "ABC123"],
      ["ABC 123", "ABC123"],
      ["aBc123", "ABC123"],
    ])("%s → %s", (input, expected) => {
      expect(normalizeReferralCode(input)).toBe(expected);
    });
  });

  it("rejects codes outside the accepted shape", () => {
    expect(isValidReferralCode("SHORT")).toBe(false);
    expect(isValidReferralCode("WAYTOOLONGCODE")).toBe(false);
    expect(isValidReferralCode("has-dash")).toBe(false);
    expect(isValidReferralCode("lower1")).toBe(false);
  });
});
