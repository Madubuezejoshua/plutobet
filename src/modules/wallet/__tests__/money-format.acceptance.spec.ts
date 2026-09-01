import { describe, expect, it } from "vitest";
import { naira, nairaWhole, parseNairaToKobo } from "@/lib/money";

/**
 * Money is stored as integer kobo and becomes a string exactly once, here.
 *
 * These cases exist because five pages had each grown their own copy of this
 * function, and FOUR of the five dropped the sign. `-1n / 100n` is `0n` and
 * `-1n % 100n` is `-1n`, so a negative kobo value rendered as `₦0.-1`, and
 * -₦400.00 rendered as `₦-400.00`. The worst offender was the regulator and
 * AML report — exactly where a negative adjustment appears.
 *
 * The other failure this guards is the reverse: showing 60,000 kobo as
 * ₦60,000 instead of ₦600.00, which would overstate a customer's balance by
 * a hundredfold.
 */

describe("naira formatting", () => {
  it.each([
    [0n, "₦0.00"],
    [1n, "₦0.01"],
    [9n, "₦0.09"],
    [10n, "₦0.10"],
    [99n, "₦0.99"],
    [100n, "₦1.00"],
    [101n, "₦1.01"],
    [20_000n, "₦200.00"],
    [60_000n, "₦600.00"],
    [40_000n, "₦400.00"],
    [100_000n, "₦1,000.00"],
    [123_456_789n, "₦1,234,567.89"],
  ])("formats %s kobo as %s", (minor, expected) => {
    expect(naira(minor)).toBe(expected);
  });

  it.each([
    [-1n, "-₦0.01"],
    [-100n, "-₦1.00"],
    [-40_000n, "-₦400.00"],
    [-123_456n, "-₦1,234.56"],
  ])("formats negative %s kobo as %s", (minor, expected) => {
    // Administrative reports legitimately show negatives — a clawback, a
    // correction, a net position. `₦0.-1` is not a number anybody can read.
    expect(naira(minor)).toBe(expected);
  });

  it("accepts the decimal string the database returns", () => {
    // postgres-js will not widen BIGINT to a JS number, so money arrives as a
    // string. Needing a conversion at each call site is what caused five
    // pages to write their own formatter instead.
    expect(naira("60000")).toBe("₦600.00");
    expect(naira("-40000")).toBe("-₦400.00");
    expect(naira("0")).toBe("₦0.00");
  });

  it("never renders a hundredfold overstatement", () => {
    // The specific mistake: treating stored kobo as if it were naira.
    expect(naira(60_000n)).not.toBe("₦60,000.00");
    expect(naira(60_000n)).toBe("₦600.00");
  });

  it("agrees with nairaWhole on the naira part", () => {
    expect(nairaWhole(60_000n)).toBe("₦600");
    expect(nairaWhole(-40_000n)).toBe("-₦400");
  });

  it("round-trips through the parser without floating point", () => {
    // `Math.round(0.29 * 100)` is 28 in IEEE-754, and that is somebody's money.
    for (const value of ["0.29", "200.00", "600.00", "1234.56"]) {
      const kobo = parseNairaToKobo(value);
      expect(kobo).not.toBeNull();
      expect(naira(kobo!)).toBe(`₦${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
    }
  });
});

describe("the verified QA bet, as a customer would read it", () => {
  // The real settled bet: 20,000 kobo staked at 3.000, paying 60,000 gross.
  const stakeMinor = 20_000n;
  const grossPayoutMinor = 60_000n;
  const profitMinor = grossPayoutMinor - stakeMinor;

  it("shows the stake as ₦200.00", () => {
    expect(naira(stakeMinor)).toBe("₦200.00");
  });

  it("shows the GROSS payout as ₦600.00", () => {
    expect(naira(grossPayoutMinor)).toBe("₦600.00");
  });

  it("shows the PROFIT as ₦400.00, distinct from the gross payout", () => {
    // Conflating the two is how a customer believes they won ₦600 profit on a
    // ₦200 stake. Gross return and profit are different numbers and must be
    // labelled differently wherever both appear.
    expect(naira(profitMinor)).toBe("₦400.00");
    expect(naira(profitMinor)).not.toBe(naira(grossPayoutMinor));
  });

  it("derives profit by integer subtraction, never by float", () => {
    expect(typeof profitMinor).toBe("bigint");
    expect(profitMinor).toBe(40_000n);
  });
});
