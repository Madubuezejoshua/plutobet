import { describe, expect, it } from "vitest";
import { normalizeCompetitionKey, normalizeTeamKey } from "../canonical-name";

/**
 * Every generated key must satisfy `teams_key_format`: ^[a-z0-9-]{1,120}$.
 *
 * The regression: "CD O´Higgins" produced `cd-o´higgins` and violated it, so
 * the fixture failed classification on every sync. U+00B4 ACUTE ACCENT is a
 * SPACING modifier, not a combining mark, so `String.normalize("NFD")` never
 * decomposes it and the combining-mark strip never matched it. The same is
 * true of several other apostrophe-like characters real feeds emit.
 *
 * Enumerating them one at a time is a losing game — this was the second such
 * surprise — so the key generator now ends with a whitelist. These tests pin
 * both the specific characters and the general property.
 */

const KEY_FORMAT = /^[a-z0-9-]{1,120}$/;

describe("team key safety", () => {
  it.each([
    "CD O´Higgins",
    "CD O’Higgins",
    "CD O‘Higgins",
    "CD O'Higgins",
    "Nott’m Forest",
    "Bayern München",
    "Beşiktaş JK",
    "Atlético Madrid",
    "Borussia Mönchengladbach",
    "Estudiantes de La Plata",
    "Fenerbahçe SK",
    "Sporting Clube de Portugal",
    "Île-de-France FC",
    "1. FC Köln",
  ])("produces a constraint-safe key for %s", (name) => {
    expect(normalizeTeamKey(name)).toMatch(KEY_FORMAT);
  });

  it("handles a name with no Latin characters at all", () => {
    // Stripping non-ASCII leaves nothing, and an empty key also violates the
    // constraint. The fallback keeps it deterministic rather than random.
    for (const name of ["Ω", "Зенит", "北京国安", "الهلال"]) {
      expect(normalizeTeamKey(name)).toMatch(KEY_FORMAT);
    }
  });

  it("is deterministic — the same club always resolves to the same key", () => {
    // A key that varied per call would create a new team row on every sync.
    for (const name of ["CD O´Higgins", "Зенит", "Beşiktaş JK"]) {
      expect(normalizeTeamKey(name)).toBe(normalizeTeamKey(name));
    }
  });

  describe("collision behaviour is deliberate", () => {
    it("MERGES apostrophe variants of one club", () => {
      // These are the same club spelled by different feeds. Merging them is
      // the entire point: two rows for one club fragments its head-to-head
      // record and its form table.
      const acute = normalizeTeamKey("CD O´Higgins");
      const curly = normalizeTeamKey("CD O’Higgins");
      const straight = normalizeTeamKey("CD O'Higgins");
      expect(acute).toBe(curly);
      expect(acute).toBe(straight);
    });

    it("MERGES accent variants of one club", () => {
      expect(normalizeTeamKey("Bayern München")).toBe(normalizeTeamKey("Bayern Munchen"));
      expect(normalizeTeamKey("Atlético Madrid")).toBe(normalizeTeamKey("Atletico Madrid"));
    });

    it("does NOT merge clubs distinguished only by their prefix", () => {
      /*
       * The rule this file exists to protect: under-merging is recoverable,
       * over-merging is not. Two rows for one club is a nuisance an operator
       * fixes by merging. One row for two clubs silently blends two histories,
       * and once bets have settled against it there is no way back.
       *
       * UD/CD and Real/Atlético prefixes are frequently the only thing
       * separating two clubs from one town, so they are preserved.
       */
      expect(normalizeTeamKey("UD Mutilvera")).not.toBe(normalizeTeamKey("CD Mutilvera"));
      expect(normalizeTeamKey("Real Madrid")).not.toBe(normalizeTeamKey("Atletico Madrid"));
    });

    it("does not collapse two different non-Latin names onto one key", () => {
      expect(normalizeTeamKey("Зенит")).not.toBe(normalizeTeamKey("Спартак"));
    });
  });

  describe("existing keys stay stable", () => {
    it.each([
      ["Arsenal", "arsenal"],
      ["Arsenal FC", "arsenal"],
      // The period is a JOINING mark and must be deleted, not turned into a
      // separator: "F.C." has to reduce to "fc" so the trailing-designator
      // strip can then remove it. Writing this expectation from observed
      // output instead of from intent is exactly how the regression below
      // got enshrined — the first version of this test asserted
      // "arsenal-fc" and locked in a bug.
      ["Arsenal F.C.", "arsenal"],
      ["Manchester United", "manchester-united"],
      ["Brighton & Hove Albion", "brighton-and-hove-albion"],
    ])("%s still maps to %s", (name, expected) => {
      // A key that already contains only permitted characters must pass
      // through the new whitelist unchanged, or every stored team row would
      // orphan on the next sync.
      expect(normalizeTeamKey(name)).toBe(expected);
    });

    it("leaves an already-clean key untouched by the safety net", () => {
      const clean = "manchester-united";
      expect(normalizeTeamKey(clean)).toBe(clean);
    });
  });

  it("never emits leading, trailing or doubled separators", () => {
    // Removed characters leave gaps behind; "o--higgins" and "-fc-" would
    // otherwise become keys distinct from their clean equivalents.
    for (const name of ["-Arsenal-", "O´´Higgins", "(Real) Madrid", "  Chelsea  "]) {
      const key = normalizeTeamKey(name);
      expect(key).toMatch(KEY_FORMAT);
      expect(key.startsWith("-")).toBe(false);
      expect(key.endsWith("-")).toBe(false);
      expect(key).not.toContain("--");
    }
  });

  it("caps an absurdly long name at the column limit", () => {
    expect(normalizeTeamKey("A".repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe("competition key safety", () => {
  it.each([
    "Türkiye - Süper Lig",
    "España - LaLiga",
    "Brazil - Paulista, Women",
    "Côte d’Ivoire - Ligue 1",
  ])("produces a constraint-safe key for %s", (name) => {
    expect(normalizeCompetitionKey(name)).toMatch(KEY_FORMAT);
  });

  it("keeps competitions that differ only by a number distinct", () => {
    // "Premier League" and "Premier League 2" are different competitions.
    expect(normalizeCompetitionKey("Premier League")).not.toBe(
      normalizeCompetitionKey("Premier League 2"),
    );
  });
});
