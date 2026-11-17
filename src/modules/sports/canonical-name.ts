import { createHash } from "node:crypto";
/**
 * Turning provider strings into stable identities.
 *
 * THE PROBLEM
 * Feeds spell the same club differently — "Arsenal", "Arsenal FC", "Arsenal
 * F.C." — and will spell it differently again after a provider update. If each
 * spelling becomes its own team row, head-to-head records fragment, form
 * tables are wrong, and the analysis Pluto AI is supposed to do in phase 18
 * inherits all of it. Getting this right now is much cheaper than migrating
 * years of results later.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE
 *
 *   **Under-merging is recoverable. Over-merging is not.**
 *
 * Two rows for one club is a nuisance an operator can fix by merging them.
 * ONE row for two clubs silently blends two teams' histories, and once bets
 * have settled against it there is no way back — you cannot tell which result
 * belonged to which side.
 *
 * So normalisation here is deliberately CONSERVATIVE. It collapses only
 * differences that cannot possibly distinguish two clubs:
 *
 *   case · diacritics · punctuation · whitespace · a trailing FC/AFC
 *
 * It specifically does NOT strip leading club prefixes — UD, CD, AC, SV, RC —
 * even though doing so would merge more spellings. Those prefixes are
 * frequently the ONLY thing distinguishing two clubs from one town: the live
 * feed carries both "UD Mutilvera" and "CD Pamplona", and Spanish football has
 * many genuine pairs like Real/Atlético or UD/CD of the same place. Stripping
 * them would merge distinct clubs, which is the failure that cannot be undone.
 *
 * Anything beyond conservative matching is handled by an explicit alias row,
 * created deliberately rather than guessed.
 */

/**
 * Suffixes safe to drop from the END of a club name.
 *
 * Each is a generic corporate/legal designator that carries no distinguishing
 * information — every club in the league could append it. Contrast with the
 * leading prefixes above, which are part of the club's identity.
 */
const TRAILING_NOISE = [
  "fc",
  "afc",
  "cf",
  "sc",
  "ac",
  "bc",
  "rfc",
  "football club",
];

/**
 * Reduces a name to a matching key.
 *
 * Two names produce the same key only when they cannot possibly be different
 * clubs. The key is for MATCHING, never for display — the original string is
 * always kept, because "Bayern München" is what a person should see.
 */
export function normalizeTeamKey(raw: string): string {
  let value = raw
    .normalize("NFD")
    // Strip combining accents, so "München" and "Munchen" match. Safe: no two
    // clubs are distinguished only by an accent.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Ampersand spelled out, so "Brighton & Hove" and "Brighton and Hove" meet.
    .replace(/&/g, " and ")
    /*
     * Punctuation splits into two kinds, and treating them alike was a bug.
     *
     * JOINING marks — a period inside an abbreviation, an apostrophe marking
     * elision — are DELETED, so "F.C." becomes "fc" and "Nott'ham" becomes
     * "nottham". Replacing them with a space instead produced "f c" and
     * "nott ham", which then failed to match the very spellings this function
     * exists to reconcile.
     *
     * SEPARATING marks — hyphens, slashes, brackets — become spaces, because
     * they stand between genuinely distinct words.
     */
    /*
     * Apostrophe VARIANTS, not just the ASCII one.
     *
     * `´` (U+00B4 ACUTE ACCENT) is a SPACING modifier, not a combining mark,
     * so NFD never decomposes it and the combining-mark range above never
     * matches it. "CD O´Higgins" therefore produced the key `cd-o´higgins`,
     * which violates `teams_key_format` (`^[a-z0-9-]{1,120}$`) and made every
     * such fixture fail classification — common across South America, Iberia
     * and Turkey.
     */
    .replace(/['’‘`´ʼʻ′＇.]/g, "")
    .replace(/[\-_/(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Only ONE trailing designator is removed, and only from the end. Looping
  // would turn "Sporting CF AC" into something unrecognisable, and a club
  // whose real name ends in two designators is not a thing.
  for (const suffix of TRAILING_NOISE) {
    if (value.endsWith(` ${suffix}`)) {
      value = value.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }

  return toSafeKey(value.replace(/\s+/g, "-"), raw);
}

/**
 * The last line of defence before the database constraint.
 *
 * Enumerating every character a provider might send is a losing game — the
 * acute accent above was already the second such surprise — so this inverts
 * the rule: anything outside `[a-z0-9-]` is dropped, whatever it is. The
 * column constraint can then never be violated by a name we have not seen.
 *
 * Existing keys are unaffected: they already contain only permitted
 * characters, so this is a no-op for every key already stored.
 *
 * When a name is entirely non-Latin the cleaned key would be empty, which the
 * constraint also rejects. Falling back to a hash of the ORIGINAL name keeps
 * the result deterministic and stable — the same club always resolves to the
 * same key — while making an accidental merge with an unrelated club
 * vanishingly unlikely. Two different names never share a fallback key unless
 * they collide in SHA-256.
 */
function toSafeKey(candidate: string, original: string): string {
  const cleaned = candidate
    .replace(/[^a-z0-9-]/g, "")
    // Collapse and trim separators left behind by removed characters, so
    // "o--higgins" and "-fc-" do not become distinct keys.
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  if (cleaned.length > 0) return cleaned;

  return `team-${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
}

/**
 * Competition key.
 *
 * Kept separate from the team key because the safe transformations differ: a
 * competition name has no club designators to strip, and its year or sponsor
 * must be preserved ("Premier League" and "Premier League 2" are different
 * competitions).
 */
export function normalizeCompetitionKey(raw: string): string {
  const value = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    // Same spacing-modifier problem as the team key: NFD does not touch these.
    .replace(/[.'’‘`´ʼʻ′＇\-_/(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+/g, "-");

  return toSafeKey(value, raw);
}

export function normalizeSportKey(raw: string): string {
  return normalizeCompetitionKey(raw);
}

export interface ParsedCompetition {
  /** Country or region, when the provider embedded one. */
  country: string | null;
  /** The competition on its own. */
  name: string;
}

/**
 * Splits a provider competition label into country and competition.
 *
 * The live feed formats these as "England - EFL Cup". The separator is a
 * spaced hyphen specifically: an unspaced one appears inside genuine names
 * ("Serie A-B playoff"), so splitting on a bare "-" would mangle them.
 *
 * Returns the whole string as the name when there is no separator, rather than
 * guessing — an unparsed competition is fine, a wrongly-split one is not.
 */
export function parseCompetitionLabel(raw: string): ParsedCompetition {
  const separator = raw.indexOf(" - ");
  if (separator === -1) return { country: null, name: raw.trim() };

  const country = raw.slice(0, separator).trim();
  const name = raw.slice(separator + 3).trim();

  // A country that is empty or implausibly long is a parse gone wrong; keep
  // the original rather than inventing a country called "Group A".
  if (!country || !name || country.length > 40) {
    return { country: null, name: raw.trim() };
  }

  return { country, name };
}

/**
 * Whether two names are confidently the same club.
 *
 * Used to warn an operator about likely duplicates. Deliberately NOT used to
 * merge anything automatically — see the note at the top of this file.
 */
export function looksLikeSameTeam(a: string, b: string): boolean {
  return normalizeTeamKey(a) === normalizeTeamKey(b);
}
