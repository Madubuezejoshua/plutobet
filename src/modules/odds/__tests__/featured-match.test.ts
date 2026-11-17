import assert from "node:assert/strict";
import test from "node:test";
import type { EventView } from "../odds.service";
import {
  getNationalFlagUrl,
  isTeamNameMatch,
  lookupEspnBadgeFromMap,
  normalizeTeamName,
  pickHottestMatch,
  pickMatchingStarPlayer,
  scoreHotMatch,
} from "../featured-match";

function makeEvent(overrides: Partial<EventView> = {}): EventView {
  return {
    id: "evt-1",
    providerEventId: "prov-1",
    sport: "football",
    league: "EPL",
    home: "Fulham",
    away: "Brentford",
    startsAt: "2026-11-21T15:00:00.000Z",
    status: "PENDING",
    markets: [
      {
        id: "mkt-1",
        key: "1x2",
        selections: [
          { id: "s1", key: "home", label: "Home", line: null, price: 2.3 },
          { id: "s2", key: "draw", label: "Draw", line: null, price: 3.3 },
          { id: "s3", key: "away", label: "Away", line: null, price: 3.1 },
        ],
      },
    ],
    ...overrides,
  };
}

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

test("picks LIVE match over upcoming marquee fixtures", () => {
  const liveMid = makeEvent({
    id: "live-1",
    home: "Bournemouth",
    away: "Everton",
    status: "LIVE",
  });
  const upcomingDerby = makeEvent({
    id: "derby",
    home: "Liverpool",
    away: "Manchester United",
    startsAt: "2026-11-22T16:30:00.000Z",
  });

  const picked = pickHottestMatch([upcomingDerby, liveMid], NOW);
  assert.equal(picked?.id, "live-1");
});

test("picks Liverpool v Manchester United over Man City v Fulham", () => {
  const manCityFulham = makeEvent({
    id: "city-fulham",
    home: "Manchester City",
    away: "Fulham",
    startsAt: "2026-11-21T12:30:00.000Z",
    markets: [
      {
        id: "m1",
        key: "1x2",
        selections: [
          { id: "a", key: "home", label: "Manchester City", line: null, price: 1.4 },
          { id: "b", key: "draw", label: "Draw", line: null, price: 4.7 },
          { id: "c", key: "away", label: "Fulham", line: null, price: 6.75 },
        ],
      },
    ],
  });

  const liverpoolManUtd = makeEvent({
    id: "liv-utd",
    home: "Liverpool",
    away: "Manchester United",
    startsAt: "2026-11-22T16:30:00.000Z",
    markets: [
      {
        id: "m2",
        key: "1x2",
        selections: [
          { id: "d", key: "home", label: "Liverpool", line: null, price: 2.05 },
          { id: "e", key: "draw", label: "Draw", line: null, price: 3.6 },
          { id: "f", key: "away", label: "Manchester United", line: null, price: 3.4 },
        ],
      },
    ],
  });

  assert.ok(scoreHotMatch(liverpoolManUtd, NOW) > scoreHotMatch(manCityFulham, NOW));
  const picked = pickHottestMatch([manCityFulham, liverpoolManUtd], NOW);
  assert.equal(picked?.id, "liv-utd");
});

test("returns null for empty fixture list", () => {
  assert.equal(pickHottestMatch([], NOW), null);
});

test("normalizes FC/AFC/SC prefixes and accented characters consistently", () => {
  assert.equal(normalizeTeamName("FC Barcelona"), "barcelona");
  assert.equal(normalizeTeamName("Arsenal FC"), "arsenal");
  assert.equal(normalizeTeamName("Atlético Madrid"), "atletico madrid");
  assert.equal(normalizeTeamName("Fenerbahçe SK"), "fenerbahce");
  assert.equal(normalizeTeamName("Manchester United"), "manchester united");
  assert.equal(normalizeTeamName("Brighton and Hove Albion"), "brighton hove albion");
});

test("resolves FlagCDN national flags and ESPN club crest aliases", () => {
  assert.equal(getNationalFlagUrl("Nigeria"), "https://flagcdn.com/w80/ng.png");
  assert.equal(getNationalFlagUrl("England"), "https://flagcdn.com/w80/gb-eng.png");
  assert.equal(getNationalFlagUrl("South Africa"), "https://flagcdn.com/w80/za.png");
  assert.equal(getNationalFlagUrl("Manchester City"), null);

  const map = new Map<string, string>([
    ["brighton & hove albion", "https://a.espncdn.com/i/teamlogos/soccer/500/331.png"],
    ["afc bournemouth", "https://a.espncdn.com/i/teamlogos/soccer/500/349.png"],
    ["bournemouth", "https://a.espncdn.com/i/teamlogos/soccer/500/349.png"],
  ]);

  assert.equal(
    lookupEspnBadgeFromMap("Brighton and Hove Albion", map),
    "https://a.espncdn.com/i/teamlogos/soccer/500/331.png",
  );
  assert.equal(
    lookupEspnBadgeFromMap("Bournemouth", map),
    "https://a.espncdn.com/i/teamlogos/soccer/500/349.png",
  );
});

test("verifies star player belongs to target team before accepting image", () => {
  assert.equal(isTeamNameMatch("Paris Saint-Germain", "PSG"), true);
  assert.equal(isTeamNameMatch("Liverpool", "Trabzonspor"), false);

  const salahResults = [
    {
      strPlayer: "Mohamed Salah",
      strTeam: "Trabzonspor",
      strSport: "Soccer",
      strCutout: "https://example.com/wrong-salah.png",
    },
    {
      strPlayer: "Mohamed Salah",
      strTeam: "Liverpool",
      strSport: "Soccer",
      strRender: "https://example.com/liverpool-salah.png",
    },
  ];

  const picked = pickMatchingStarPlayer(salahResults, "Liverpool", "football");
  assert.deepEqual(picked, {
    url: "https://example.com/liverpool-salah.png",
    name: "Mohamed Salah",
  });
});
