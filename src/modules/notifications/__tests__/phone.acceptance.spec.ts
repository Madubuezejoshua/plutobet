import { describe, expect, it } from "vitest";
import { InvalidPhoneNumberError, isValidPhone, maskPhone, normalizePhone } from "../phone";

/**
 * Phone normalisation is not string tidying — it is an identity control.
 *
 * If `0803...` and `+234803...` produce different stored values then one
 * person holds several accounts, per-destination OTP throttles are bypassed
 * by changing format (which costs real money in SMS fees), and contact
 * matching for self-exclusion misses.
 */
describe("Nigerian phone normalisation", () => {
  it("collapses every common way of writing the same number", () => {
    const forms = [
      "08031234567",
      "+2348031234567",
      "2348031234567",
      "8031234567",
      "0803 123 4567",
      "+234 803 123 4567",
      "0803-123-4567",
      "(0803) 123 4567",
      "  08031234567  ",
    ];
    const normalised = new Set(forms.map(normalizePhone));

    // ALL of them are one person. More than one entry here is a duplicate
    // account and a bypassed rate limit.
    expect(normalised.size).toBe(1);
    expect([...normalised][0]).toBe("+2348031234567");
  });

  it("accepts numbers from each network", () => {
    expect(normalizePhone("08031234567")).toBe("+2348031234567"); // MTN
    expect(normalizePhone("08051234567")).toBe("+2348051234567"); // Glo
    expect(normalizePhone("08021234567")).toBe("+2348021234567"); // Airtel
    expect(normalizePhone("08091234567")).toBe("+2348091234567"); // 9mobile
  });

  it("rejects an unassigned network prefix", () => {
    // A 10-digit string with a prefix no carrier operates is a typo. Finding
    // that out after paying to send an SMS is the expensive way.
    expect(() => normalizePhone("08991234567")).toThrow(InvalidPhoneNumberError);
    expect(() => normalizePhone("01234567890")).toThrow(InvalidPhoneNumberError);
  });

  it("rejects wrong lengths and non-numeric input", () => {
    for (const bad of ["", "0803123456", "080312345678", "not-a-number", "+1234567890"]) {
      expect(() => normalizePhone(bad)).toThrow(InvalidPhoneNumberError);
    }
  });

  it("reports validity without throwing", () => {
    expect(isValidPhone("08031234567")).toBe(true);
    expect(isValidPhone("garbage")).toBe(false);
  });

  it("masks all but the last four digits for display", () => {
    // A full number on a support screen is what a screenshot leaks.
    expect(maskPhone("+2348031234567")).toBe("+234 803 ***4567");
  });
});
