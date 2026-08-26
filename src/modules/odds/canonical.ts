/**
 * The canonical market/selection key vocabulary.
 *
 * These keys are the contract between ingestion and settlement: Phase 4
 * resolves a bet by parsing the key stored on its leg, so a key that is
 * ambiguous or guessed is a wrong payout waiting to happen. Vendor adapters
 * translate provider labels into this vocabulary and nothing else.
 *
 * EVERY mapper here returns null when it cannot map a label with confidence.
 * Callers must skip those selections. Showing a user fewer markets is a
 * cosmetic problem; showing them a selection whose key means something other
 * than its label is a money problem.
 */

export type MarketKey =
  | "1x2"
  | "double_chance"
  | "over_under"
  | "btts"
  | "handicap"
  | "correct_score"
  | "ht_ft";

export const MARKET_KEYS: readonly MarketKey[] = [
  "1x2",
  "double_chance",
  "over_under",
  "btts",
  "handicap",
  "correct_score",
  "ht_ft",
] as const;

/**
 * Selection key formats, by market:
 *
 *   1x2            home | draw | away
 *   double_chance  home_or_draw | home_or_away | draw_or_away
 *   over_under     over_<line> | under_<line>          e.g. over_2.5
 *   btts           yes | no
 *   handicap       home_<line> | away_<line>           e.g. home_-1.5
 *   correct_score  <home>-<away> | other               e.g. 2-1
 *   ht_ft          <ht>/<ft> using home|draw|away      e.g. home/draw
 *
 * `_or_` (double chance) and `/` (half-time/full-time) are deliberately
 * different separators: both markets combine two outcomes, and a shared
 * format would make "home_draw" mean "home or draw" in one market and "home
 * at HT, draw at FT" in another.
 */

type Outcome = "home" | "draw" | "away";

function normalise(raw: string): string {
  return raw.toLowerCase().trim();
}

/**
 * Strips every separator a provider might use between words, so market and
 * selection aliases can be listed in one plain form. `/` is included
 * deliberately: "Over/Under" and "Half Time/Full Time" are both common
 * spellings, and omitting it silently dropped those markets from the feed.
 *
 * Selection mappers that need `/` as a meaningful separator (ht_ft) split on
 * it BEFORE squashing each half.
 */
function squash(raw: string): string {
  return normalise(raw).replace(/[\s_\-./]/g, "");
}

/** Maps a single 1/X/2 token. Null when the token is not recognisable. */
function toOutcome(token: string): Outcome | null {
  const v = squash(token);
  if (["1", "home", "h", "host", "homewin"].includes(v)) return "home";
  if (["x", "draw", "d", "tie", "drawn"].includes(v)) return "draw";
  if (["2", "away", "a", "guest", "awaywin"].includes(v)) return "away";
  return null;
}

export function mapMarketKey(raw: string): MarketKey | null {
  const v = squash(raw);
  if (["1x2", "moneyline", "ml", "matchwinner", "matchresult", "h2h", "fulltimeresult"].includes(v)) {
    return "1x2";
  }
  if (["doublechance", "dc"].includes(v)) return "double_chance";
  if (["overunder", "totals", "total", "ou", "goalsoverunder"].includes(v)) return "over_under";
  if (["btts", "bothteamstoscore", "goalgoal", "gg"].includes(v)) return "btts";
  if (["handicap", "spread", "spreads", "asianhandicap", "ah"].includes(v)) return "handicap";
  if (["correctscore", "cs", "exactscore"].includes(v)) return "correct_score";
  if (["htft", "halftimefulltime", "halftimefulltimeresult", "doubleresult"].includes(v)) {
    return "ht_ft";
  }
  return null;
}

function mapOneXTwo(label: string): string | null {
  // No fallthrough default. An unrecognised label used to become "home",
  // which silently sold the user the wrong side of the match.
  return toOutcome(label);
}

function mapDoubleChance(label: string): string | null {
  const v = squash(label);
  // Only the standard orderings (1X, 12, X2), never the reversed numeric
  // forms. "21" would also be the squashed form of the correct-score label
  // "2-1", so accepting it would let a scoreline silently become a double
  // chance bet. Worded forms are unambiguous and safe in either order.
  if (["1x", "homeordraw", "draworhome", "homedraw"].includes(v)) return "home_or_draw";
  if (["12", "homeoraway", "awayorhome", "homeaway"].includes(v)) return "home_or_away";
  if (["x2", "draworaway", "awayordraw", "drawaway"].includes(v)) return "draw_or_away";
  return null;
}

function mapOverUnder(label: string, line: number | undefined): string | null {
  // The line is part of the key's meaning — "over" alone does not identify a
  // bet. Without it we cannot build a settleable key, so skip.
  if (line === undefined || !Number.isFinite(line)) return null;
  const v = squash(label);
  if (v.startsWith("o") || v.includes("over")) return `over_${line}`;
  if (v.startsWith("u") || v.includes("under")) return `under_${line}`;
  return null;
}

function mapBtts(label: string): string | null {
  const v = squash(label);
  if (["yes", "y", "goalgoal", "gg", "both"].includes(v)) return "yes";
  if (["no", "n", "nogoal", "ng"].includes(v)) return "no";
  return null;
}

function mapHandicap(label: string, line: number | undefined): string | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  const outcome = toOutcome(label);
  // Only the two sides carry a handicap; a draw line is a different market.
  if (outcome === "home") return `home_${line}`;
  if (outcome === "away") return `away_${line}`;
  return null;
}

function mapCorrectScore(label: string): string | null {
  const v = normalise(label);
  if (["other", "any other", "any other score", "aos", "others"].includes(v)) return "other";

  // Accept "2-1", "2:1", "2 - 1". Reject anything else rather than guessing
  // which number is the home side.
  const match = /^(\d{1,2})\s*[-:]\s*(\d{1,2})$/.exec(v);
  if (!match) return null;
  const [, home, away] = match;
  return `${Number(home)}-${Number(away)}`;
}

function mapHtFt(label: string): string | null {
  // Accept "1/1", "Home/Draw", "1-X", "Home - Away".
  const parts = normalise(label).split(/[/\-]/);
  if (parts.length !== 2) return null;
  const half = toOutcome(parts[0]!);
  const full = toOutcome(parts[1]!);
  if (!half || !full) return null;
  return `${half}/${full}`;
}

/**
 * Translates a provider selection label into a canonical key, or null when it
 * cannot be mapped with confidence. `line` is required for the markets whose
 * key encodes one.
 */
export function mapSelectionKey(
  market: MarketKey,
  label: string,
  line?: number,
): string | null {
  switch (market) {
    case "1x2":
      return mapOneXTwo(label);
    case "double_chance":
      return mapDoubleChance(label);
    case "over_under":
      return mapOverUnder(label, line);
    case "btts":
      return mapBtts(label);
    case "handicap":
      return mapHandicap(label, line);
    case "correct_score":
      return mapCorrectScore(label);
    case "ht_ft":
      return mapHtFt(label);
  }
}
