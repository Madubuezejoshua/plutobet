import { describe, expect, it } from "vitest";
import {
  looksLikeSameTeam,
  normalizeCompetitionKey,
  normalizeTeamKey,
  parseCompetitionLabel,
} from "../canonical-name";

/**
 * The asymmetry this module is built around: under-merging is a nuisance an
 * operator can fix, over-merging silently blends two clubs' histories and
 * cannot be undone once bets have settled against it.
 *
 * So the tests come in two halves, and the second half matters more.
 */
describe("team name canonicalisation", () => {
  describe("collapses differences that cannot distinguish two clubs", () => {
    it.each([
      ["Arsenal", "Arsenal FC"],
      ["Arsenal FC", "Arsenal F.C."],
      ["Southampton FC", "southampton"],
      ["Stevenage FC", "STEVENAGE"],
      ["Bayern München", "Bayern Munchen"],
      ["Brighton & Hove Albion", "Brighton and Hove Albion"],
      ["Nott'ham Forest", "Nottham Forest"],
      ["  Chelsea   FC  ", "Chelsea"],
      ["Middlesbrough FC", "Middlesbrough"],
    ])("%s === %s", (a, b) => {
      expect(normalizeTeamKey(a)).toBe(normalizeTeamKey(b));
      expect(looksLikeSameTeam(a, b)).toBe(true);
    });
  });

  /*
   * The half that matters. Every case here is a pair a more aggressive
   * normaliser WOULD have merged — and each merge would be permanent
   * corruption of two clubs' records.
   */
  describe("never merges clubs that a greedy normaliser would", () => {
    it.each([
      // Straight from the live feed. Spanish club prefixes are identity, not
      // noise: strip them and two different clubs from Navarre become one.
      ["UD Mutilvera", "CD Pamplona"],
      ["UD Las Palmas", "CD Las Palmas"],
      ["Real Sociedad", "Real Madrid"],
      ["AC Milan", "Inter Milan"],
      ["Sporting CP", "Sporting Gijon"],
      // A numeral is part of the name — reserve and senior sides differ.
      ["Bayern Munich", "Bayern Munich II"],
      ["Manchester United", "Manchester City"],
      ["Atletico Madrid", "Athletic Bilbao"],
    ])("%s !== %s", (a, b) => {
      expect(normalizeTeamKey(a)).not.toBe(normalizeTeamKey(b));
      expect(looksLikeSameTeam(a, b)).toBe(false);
    });

    /*
     * Only ONE trailing designator is dropped. Looping would eat its way into
     * genuine names — and a club whose real name ends in two of them does not
     * exist.
     */
    it("does not strip designators repeatedly", () => {
      expect(normalizeTeamKey("Sporting CF AC")).toBe("sporting-cf");
    });

    it("keeps a leading designator that is part of the name", () => {
      expect(normalizeTeamKey("FC Barcelona")).toBe("fc-barcelona");
      expect(normalizeTeamKey("AC Milan")).toBe("ac-milan");
    });
  });

  it("produces a key that is safe to store and index", () => {
    for (const name of ["Bayern München", "Nott'ham Forest", "Brighton & Hove", "  spaced  "]) {
      const key = normalizeTeamKey(name);
      expect(key).toMatch(/^[a-z0-9-]+$/);
      expect(key.startsWith("-")).toBe(false);
      expect(key.endsWith("-")).toBe(false);
    }
  });
});

describe("competition canonicalisation", () => {
  it("collapses spelling differences", () => {
    expect(normalizeCompetitionKey("Premier League")).toBe(normalizeCompetitionKey("premier league"));
    expect(normalizeCompetitionKey("Ligue 1")).toBe("ligue-1");
  });

  /*
   * A numeral or suffix in a competition name is meaningful — the reserve
   * league is not the senior one.
   */
  it("keeps competitions with numeric suffixes apart", () => {
    expect(normalizeCompetitionKey("Premier League")).not.toBe(
      normalizeCompetitionKey("Premier League 2"),
    );
    expect(normalizeCompetitionKey("Serie A")).not.toBe(normalizeCompetitionKey("Serie B"));
  });

  describe("splitting the provider's country prefix", () => {
    it("parses the shape the live feed actually sends", () => {
      expect(parseCompetitionLabel("England - EFL Cup")).toEqual({
        country: "England",
        name: "EFL Cup",
      });
    });

    it("handles a competition with no country", () => {
      expect(parseCompetitionLabel("UEFA Champions League")).toEqual({
        country: null,
        name: "UEFA Champions League",
      });
    });

    /*
     * The separator is a SPACED hyphen. An unspaced one appears inside real
     * competition names, and splitting on it would invent a country.
     */
    it("does not split on a hyphen inside a name", () => {
      expect(parseCompetitionLabel("Serie A-B playoff")).toEqual({
        country: null,
        name: "Serie A-B playoff",
      });
    });

    it("keeps the original when the split would produce nonsense", () => {
      expect(parseCompetitionLabel(" - EFL Cup").country).toBeNull();
      expect(parseCompetitionLabel("England - ").country).toBeNull();
    });

    it("only splits on the FIRST separator", () => {
      expect(parseCompetitionLabel("Spain - Copa del Rey - Round of 16")).toEqual({
        country: "Spain",
        name: "Copa del Rey - Round of 16",
      });
    });
  });
});
