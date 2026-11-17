import { describe, expect, it } from "vitest";
import { MARKET_KEYS, mapMarketKey, mapSelectionKey, type MarketKey } from "../canonical";

/**
 * These keys are the contract between ingestion and settlement, so the tests
 * that matter most are the negative ones: a label we cannot map must produce
 * null, never a plausible-looking guess. The previous implementation defaulted
 * unrecognised labels to "home"/"no", which sold users the wrong side of a
 * market at the other side's price.
 */

describe("market key mapping", () => {
  it("maps the football markets that matter in this market", () => {
    expect(mapMarketKey("1X2")).toBe("1x2");
    expect(mapMarketKey("Match Result")).toBe("1x2");
    expect(mapMarketKey("Double Chance")).toBe("double_chance");
    expect(mapMarketKey("Over/Under")).toBe("over_under");
    expect(mapMarketKey("Both Teams To Score")).toBe("btts");
    expect(mapMarketKey("Asian Handicap")).toBe("handicap");
    expect(mapMarketKey("Correct Score")).toBe("correct_score");
    expect(mapMarketKey("Half Time / Full Time")).toBe("ht_ft");
  });

  it("returns null for an unsupported market rather than guessing", () => {
    expect(mapMarketKey("First Goalscorer")).toBeNull();
    expect(mapMarketKey("Player Props")).toBeNull();
    expect(mapMarketKey("")).toBeNull();
  });
});

describe("1x2 selections", () => {
  it("maps the three outcomes across notations", () => {
    expect(mapSelectionKey("1x2", "1")).toBe("home");
    expect(mapSelectionKey("1x2", "Home")).toBe("home");
    expect(mapSelectionKey("1x2", "X")).toBe("draw");
    expect(mapSelectionKey("1x2", "Draw")).toBe("draw");
    expect(mapSelectionKey("1x2", "2")).toBe("away");
    expect(mapSelectionKey("1x2", "Away")).toBe("away");
  });

  // The regression that motivated this module.
  it("returns null for an unrecognised label instead of defaulting to home", () => {
    expect(mapSelectionKey("1x2", "Arsenal FC")).toBeNull();
    expect(mapSelectionKey("1x2", "")).toBeNull();
    expect(mapSelectionKey("1x2", "3")).toBeNull();
  });
});

describe("double chance selections", () => {
  it("maps all three pairings in either order", () => {
    expect(mapSelectionKey("double_chance", "1X")).toBe("home_or_draw");
    expect(mapSelectionKey("double_chance", "Home or Draw")).toBe("home_or_draw");
    expect(mapSelectionKey("double_chance", "12")).toBe("home_or_away");
    expect(mapSelectionKey("double_chance", "X2")).toBe("draw_or_away");
    expect(mapSelectionKey("double_chance", "Draw or Away")).toBe("draw_or_away");
  });

  it("returns null for a single outcome, which is a different market", () => {
    expect(mapSelectionKey("double_chance", "Home")).toBeNull();
    expect(mapSelectionKey("double_chance", "X")).toBeNull();
  });
});

describe("over/under selections", () => {
  it("encodes the line into the key", () => {
    expect(mapSelectionKey("over_under", "Over", 2.5)).toBe("over_2.5");
    expect(mapSelectionKey("over_under", "Under", 2.5)).toBe("under_2.5");
    expect(mapSelectionKey("over_under", "O", 1.5)).toBe("over_1.5");
  });

  // "over" without a line is not a bet anyone can settle.
  it("returns null when the line is missing or unusable", () => {
    expect(mapSelectionKey("over_under", "Over", undefined)).toBeNull();
    expect(mapSelectionKey("over_under", "Over", Number.NaN)).toBeNull();
  });

  it("returns null for a label that is neither over nor under", () => {
    expect(mapSelectionKey("over_under", "Exactly", 2.5)).toBeNull();
  });
});

describe("btts selections", () => {
  it("maps yes and no", () => {
    expect(mapSelectionKey("btts", "Yes")).toBe("yes");
    expect(mapSelectionKey("btts", "GG")).toBe("yes");
    expect(mapSelectionKey("btts", "No")).toBe("no");
    expect(mapSelectionKey("btts", "NG")).toBe("no");
  });

  it("returns null for anything else instead of defaulting to no", () => {
    expect(mapSelectionKey("btts", "Maybe")).toBeNull();
    expect(mapSelectionKey("btts", "")).toBeNull();
  });
});

describe("handicap selections", () => {
  it("encodes side and line, including negative lines", () => {
    expect(mapSelectionKey("handicap", "Home", -1)).toBe("home_-1");
    expect(mapSelectionKey("handicap", "Away", 1.5)).toBe("away_1.5");
  });

  it("returns null without a line, and for a draw", () => {
    expect(mapSelectionKey("handicap", "Home", undefined)).toBeNull();
    expect(mapSelectionKey("handicap", "Draw", -1)).toBeNull();
  });
});

describe("correct score selections", () => {
  it("normalises separators to home-away order", () => {
    expect(mapSelectionKey("correct_score", "2-1")).toBe("2-1");
    expect(mapSelectionKey("correct_score", "2:1")).toBe("2-1");
    expect(mapSelectionKey("correct_score", "2 - 1")).toBe("2-1");
    expect(mapSelectionKey("correct_score", "0-0")).toBe("0-0");
  });

  it("keeps home and away distinct — 2-1 is not 1-2", () => {
    expect(mapSelectionKey("correct_score", "2-1")).not.toBe(
      mapSelectionKey("correct_score", "1-2"),
    );
  });

  it("maps the any-other-score bucket", () => {
    expect(mapSelectionKey("correct_score", "Other")).toBe("other");
    expect(mapSelectionKey("correct_score", "Any Other Score")).toBe("other");
  });

  // A label whose home/away order we cannot be sure of must be dropped: a
  // reversed score pays the wrong side on every such bet.
  it("returns null for a score whose orientation is ambiguous", () => {
    expect(mapSelectionKey("correct_score", "Arsenal 2 Chelsea 1")).toBeNull();
    expect(mapSelectionKey("correct_score", "2")).toBeNull();
    expect(mapSelectionKey("correct_score", "2-1-1")).toBeNull();
  });
});

describe("half-time/full-time selections", () => {
  it("maps all nine combinations", () => {
    const expected: Record<string, string> = {
      "1/1": "home/home",
      "1/X": "home/draw",
      "1/2": "home/away",
      "X/1": "draw/home",
      "X/X": "draw/draw",
      "X/2": "draw/away",
      "2/1": "away/home",
      "2/X": "away/draw",
      "2/2": "away/away",
    };
    for (const [label, key] of Object.entries(expected)) {
      expect(mapSelectionKey("ht_ft", label)).toBe(key);
    }
    expect(new Set(Object.values(expected)).size).toBe(9);
  });

  it("accepts worded and dash-separated forms", () => {
    expect(mapSelectionKey("ht_ft", "Home/Draw")).toBe("home/draw");
    expect(mapSelectionKey("ht_ft", "Draw - Away")).toBe("draw/away");
  });

  it("preserves order — half-time first, full-time second", () => {
    expect(mapSelectionKey("ht_ft", "1/2")).toBe("home/away");
    expect(mapSelectionKey("ht_ft", "2/1")).toBe("away/home");
  });

  it("returns null for a single outcome or an unparseable half", () => {
    expect(mapSelectionKey("ht_ft", "1")).toBeNull();
    expect(mapSelectionKey("ht_ft", "1/9")).toBeNull();
  });
});

describe("key vocabulary hygiene", () => {
  it("never maps a market's selections onto another market's key space", () => {
    // double_chance and ht_ft both combine two outcomes; their separators must
    // keep the results distinguishable, or "home_draw" would be ambiguous.
    const dc = mapSelectionKey("double_chance", "1X");
    const htft = mapSelectionKey("ht_ft", "1/X");
    expect(dc).toBe("home_or_draw");
    expect(htft).toBe("home/draw");
    expect(dc).not.toBe(htft);
  });

  it("maps no label to a key for a market it does not belong to", () => {
    // A 1X2 label must not accidentally satisfy correct_score, and so on.
    const crossTalk: Array<[MarketKey, string]> = [
      ["correct_score", "Home"],
      ["ht_ft", "Yes"],
      ["btts", "1"],
      ["double_chance", "2-1"],
    ];
    for (const [market, label] of crossTalk) {
      expect(mapSelectionKey(market, label)).toBeNull();
    }
  });

  it("covers every declared market key", () => {
    // Guards against adding a MarketKey and forgetting the mapper — the switch
    // is exhaustive, so an unmapped market would be a compile error, but this
    // also catches a mapper that returns null for everything.
    const sample: Record<MarketKey, [string, number | undefined]> = {
      "1x2": ["Home", undefined],
      double_chance: ["1X", undefined],
      over_under: ["Over", 2.5],
      btts: ["Yes", undefined],
      handicap: ["Home", -1],
      correct_score: ["2-1", undefined],
      ht_ft: ["1/1", undefined],
    };
    for (const market of MARKET_KEYS) {
      const [label, line] = sample[market];
      expect(mapSelectionKey(market, label, line)).not.toBeNull();
    }
  });
});
