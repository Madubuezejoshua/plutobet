/**
 * Canonical catalog of live sports offered on PlutoBet.
 *
 * Every slug matches the exact `odds-api.io` `/v3/sports` slug so fixture
 * sync, live polling, navigation tabs, and board filters stay aligned in one
 * place. `tier: "primary"` sports sync first so free-tier quota caps never
 * starve the core Nigerian sportsbook.
 */

export interface SportDefinition {
  readonly key: string;
  readonly label: string;
  readonly shortLabel: string;
  /** Display name expected by `/v3/odds/updated` on odds-api.io. */
  readonly providerName: string;
  /** True when the sport typically prices 2-way (Home / Away, no Draw). */
  readonly twoWayDefault: boolean;
  readonly tier: "primary" | "extended";
  /** Substrings (case-insensitive) used to surface marquee competitions first. */
  readonly topLeagues: readonly string[];
}

export const SPORTS_CATALOG: readonly SportDefinition[] = [
  {
    key: "football",
    label: "Football",
    shortLabel: "Football",
    providerName: "Football",
    twoWayDefault: false,
    tier: "primary",
    topLeagues: [
      "Premier League",
      "Champions League",
      "La Liga",
      "Serie A",
      "Bundesliga",
      "Ligue 1",
      "Europa League",
      "NPFL",
      "World Cup",
      "AFCON",
    ],
  },
  {
    key: "basketball",
    label: "Basketball",
    shortLabel: "Basketball",
    providerName: "Basketball",
    twoWayDefault: true,
    tier: "primary",
    topLeagues: ["NBA", "EuroLeague", "NCAA", "ACB", "WNBA", "FIBA"],
  },
  {
    key: "tennis",
    label: "Tennis",
    shortLabel: "Tennis",
    providerName: "Tennis",
    twoWayDefault: true,
    tier: "primary",
    topLeagues: ["ATP", "WTA", "Grand Slam", "Challenger", "Davis Cup", "ITF"],
  },
  {
    key: "table-tennis",
    label: "Table Tennis",
    shortLabel: "Table Tennis",
    providerName: "Table Tennis",
    twoWayDefault: true,
    tier: "primary",
    topLeagues: ["WTT", "TT Elite", "TT Cup", "Czech Liga Pro", "Setka Cup"],
  },
  {
    key: "esports",
    label: "Esports",
    shortLabel: "Esports",
    providerName: "Esports",
    twoWayDefault: true,
    tier: "primary",
    topLeagues: ["Counter-Strike", "League of Legends", "Dota 2", "Valorant", "ESL"],
  },
  {
    key: "ice-hockey",
    label: "Ice Hockey",
    shortLabel: "Hockey",
    providerName: "Ice Hockey",
    twoWayDefault: false,
    tier: "extended",
    topLeagues: ["NHL", "KHL", "SHL", "Liiga", "DEL", "AHL"],
  },
  {
    key: "volleyball",
    label: "Volleyball",
    shortLabel: "Volleyball",
    providerName: "Volleyball",
    twoWayDefault: true,
    tier: "extended",
    topLeagues: ["Champions League", "SuperLega", "PlusLiga", "VNL", "Serie A1"],
  },
  {
    key: "handball",
    label: "Handball",
    shortLabel: "Handball",
    providerName: "Handball",
    twoWayDefault: false,
    tier: "extended",
    topLeagues: ["Champions League", "Bundesliga", "Starligue", "ASOBAL"],
  },
  {
    key: "mma",
    label: "MMA / UFC",
    shortLabel: "MMA",
    providerName: "MMA",
    twoWayDefault: true,
    tier: "extended",
    topLeagues: ["UFC", "PFL", "Bellator", "ONE", "KSW"],
  },
  {
    key: "boxing",
    label: "Boxing",
    shortLabel: "Boxing",
    providerName: "Boxing",
    twoWayDefault: false,
    tier: "extended",
    topLeagues: ["World Title", "WBC", "WBA", "IBF", "WBO", "Heavyweight"],
  },
  {
    key: "american-football",
    label: "American Football",
    shortLabel: "NFL",
    providerName: "American Football",
    twoWayDefault: true,
    tier: "extended",
    topLeagues: ["NFL", "NCAA", "CFL"],
  },
  {
    key: "baseball",
    label: "Baseball",
    shortLabel: "Baseball",
    providerName: "Baseball",
    twoWayDefault: true,
    tier: "extended",
    topLeagues: ["MLB", "NPB", "KBO", "LIDOM"],
  },
  {
    key: "cricket",
    label: "Cricket",
    shortLabel: "Cricket",
    providerName: "Cricket",
    twoWayDefault: true,
    tier: "extended",
    topLeagues: ["IPL", "T20", "ODI", "Test", "Big Bash", "The Ashes", "ICC"],
  },
] as const;

export type SportKey = (typeof SPORTS_CATALOG)[number]["key"];

export const ALL_SPORT_KEYS: readonly SportKey[] = SPORTS_CATALOG.map((s) => s.key);

export const PRIMARY_SPORT_KEYS: readonly SportKey[] = SPORTS_CATALOG
  .filter((s) => s.tier === "primary")
  .map((s) => s.key);

export const SPORT_BY_KEY: Readonly<Record<string, SportDefinition>> = Object.fromEntries(
  SPORTS_CATALOG.map((s) => [s.key, s]),
);

export const SPORT_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  SPORTS_CATALOG.map((s) => [s.key, s.providerName]),
);

const SPORT_ALIASES: Readonly<Record<string, SportKey>> = {
  "mixed-martial-arts": "mma",
  ufc: "mma",
  nfl: "american-football",
  hockey: "ice-hockey",
};

export function resolveSportKey(raw?: string | null): SportKey {
  const normalized = raw?.trim().toLowerCase() ?? "";
  if (normalized && normalized in SPORT_BY_KEY) {
    return normalized as SportKey;
  }
  if (normalized && normalized in SPORT_ALIASES) {
    return SPORT_ALIASES[normalized]!;
  }
  return "football";
}

export function sportLabel(key: string): string {
  return SPORT_BY_KEY[key]?.label ?? key;
}

/** Returns a rank (lower = higher priority) for marquee leagues of a sport. */
export function leaguePriority(sport: string, leagueLabel: string): number {
  const def = SPORT_BY_KEY[sport];
  if (!def) return 999;
  const hay = leagueLabel.toLowerCase();
  for (let i = 0; i < def.topLeagues.length; i += 1) {
    if (hay.includes(def.topLeagues[i]!.toLowerCase())) return i;
  }
  return 999;
}
