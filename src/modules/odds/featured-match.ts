import type { EventView } from "./odds.service";

export interface TeamVisual {
  teamName: string;
  badgeUrl: string | null;
  playerImageUrl: string | null;
  playerName: string | null;
  source: "espn" | "flagcdn" | "thesportsdb" | "none";
}

export interface MatchVisuals {
  home: TeamVisual;
  away: TeamVisual;
}

const TIER_1_TEAMS = new Set([
  "liverpool",
  "manchester united",
  "manchester city",
  "arsenal",
  "chelsea",
  "real madrid",
  "barcelona",
  "fc barcelona",
  "bayern munich",
  "fc bayern munich",
  "paris saint-germain",
  "paris saint germain",
  "psg",
  "inter milan",
  "inter",
  "ac milan",
  "milan",
  "juventus",
  "atletico madrid",
  "borussia dortmund",
  "napoli",
  "nigeria",
  "brazil",
  "argentina",
  "france",
  "england",
  "spain",
  "germany",
  "portugal",
]);

const TIER_2_TEAMS = new Set([
  "tottenham hotspur",
  "tottenham",
  "newcastle united",
  "newcastle",
  "aston villa",
  "west ham united",
  "west ham",
  "bayer leverkusen",
  "as roma",
  "roma",
  "lazio",
  "benfica",
  "porto",
  "ajax",
  "inter miami",
  "al-hilal",
  "al-nassr",
  "sporting cp",
  "brighton",
  "brighton and hove albion",
]);

const HOT_LEAGUES = new Set([
  "epl",
  "premier league",
  "english premier league",
  "uefa champions league",
  "champions league",
  "la liga",
  "serie a",
  "bundesliga",
  "ligue 1",
  "world cup",
  "fifa world cup",
  "afcon",
  "africa cup of nations",
  "uefa europa league",
]);

const TEAM_SEARCH_ALIASES: Record<string, string[]> = {
  "brighton and hove albion": ["Brighton", "Brighton & Hove Albion"],
  "tottenham hotspur": ["Tottenham", "Tottenham Hotspur"],
  "wolverhampton wanderers": ["Wolves", "Wolverhampton"],
  "nottingham forest": ["Nottingham Forest"],
  "newcastle united": ["Newcastle", "Newcastle United"],
  "west ham united": ["West Ham", "West Ham United"],
  "leeds united": ["Leeds", "Leeds United"],
  "crystal palace": ["Crystal Palace"],
  "aston villa": ["Aston Villa"],
  "manchester united": ["Manchester United"],
  "manchester city": ["Manchester City"],
  "ipswich town": ["Ipswich", "Ipswich Town"],
  "coventry city": ["Coventry", "Coventry City"],
  "hull city": ["Hull", "Hull City"],
  "paris saint-germain": ["Paris SG", "Paris Saint-Germain", "PSG"],
  psg: ["Paris Saint-Germain", "Paris SG"],
  "inter milan": ["Inter", "Inter Milan", "Internazionale"],
  "ac milan": ["AC Milan", "Milan"],
  "bayern munich": ["Bayern Munich", "Bayern Munchen"],
  "atletico madrid": ["Atletico Madrid", "Atletico de Madrid"],
  "athletic bilbao": ["Athletic Club", "Athletic Bilbao"],
  "real betis": ["Real Betis"],
  "real sociedad": ["Real Sociedad"],
  "borussia dortmund": ["Borussia Dortmund", "Dortmund"],
  "bayer leverkusen": ["Bayer Leverkusen"],
  "rb leipzig": ["RB Leipzig"],
  "sporting cp": ["Sporting CP", "Sporting Lisbon"],
  "fc porto": ["Porto", "FC Porto"],
  "sl benfica": ["Benfica", "SL Benfica"],
};

/**
 * Curated flagship players for major clubs & national teams so the Hottest
 * Match hero banner displays recognizable stars instead of arbitrary alphabetical
 * entries from free-tier squad endpoints. Always falls back automatically to
 * `lookup_all_players.php` for any club not listed here.
 */
const STAR_PLAYERS_BY_TEAM: Record<string, string[]> = {
  arsenal: ["Bukayo Saka", "Martin Odegaard", "Declan Rice"],
  "manchester city": ["Erling Haaland", "Phil Foden", "Rodri"],
  liverpool: ["Mohamed Salah", "Virgil van Dijk", "Alexis Mac Allister"],
  "manchester united": ["Bruno Fernandes", "Kobbie Mainoo", "Marcus Rashford"],
  chelsea: ["Cole Palmer", "Enzo Fernandez", "Moises Caicedo"],
  "tottenham hotspur": ["James Maddison", "Dejan Kulusevski", "Dominic Solanke"],
  tottenham: ["James Maddison", "Dejan Kulusevski", "Dominic Solanke"],
  "newcastle united": ["Alexander Isak", "Bruno Guimaraes", "Anthony Gordon"],
  newcastle: ["Alexander Isak", "Bruno Guimaraes", "Anthony Gordon"],
  "aston villa": ["Ollie Watkins", "Morgan Rogers", "Emiliano Martinez"],
  "west ham united": ["Jarrod Bowen", "Mohammed Kudus", "Lucas Paqueta"],
  "west ham": ["Jarrod Bowen", "Mohammed Kudus", "Lucas Paqueta"],
  brighton: ["Kaoru Mitoma", "Danny Welbeck"],
  "brighton hove albion": ["Kaoru Mitoma", "Danny Welbeck"],
  "real madrid": ["Kylian Mbappe", "Vinicius Junior", "Jude Bellingham"],
  barcelona: ["Lamine Yamal", "Raphinha", "Pedri"],
  "atletico madrid": ["Antoine Griezmann", "Julian Alvarez", "Jan Oblak"],
  "bayern munich": ["Harry Kane", "Jamal Musiala", "Joshua Kimmich"],
  "borussia dortmund": ["Serhou Guirassy", "Julian Brandt", "Karim Adeyemi"],
  "bayer leverkusen": ["Florian Wirtz", "Granit Xhaka"],
  "paris saint-germain": ["Ousmane Dembele", "Achraf Hakimi", "Vitinha"],
  "paris saint germain": ["Ousmane Dembele", "Achraf Hakimi", "Vitinha"],
  psg: ["Ousmane Dembele", "Achraf Hakimi", "Vitinha"],
  "inter milan": ["Lautaro Martinez", "Nicolo Barella", "Marcus Thuram"],
  inter: ["Lautaro Martinez", "Nicolo Barella", "Marcus Thuram"],
  "ac milan": ["Rafael Leao", "Christian Pulisic", "Theo Hernandez"],
  milan: ["Rafael Leao", "Christian Pulisic", "Theo Hernandez"],
  juventus: ["Dusan Vlahovic", "Kenan Yildiz", "Manuel Locatelli"],
  napoli: ["Romelu Lukaku", "Khvicha Kvaratskhelia", "Scott McTominay"],
  "as roma": ["Paulo Dybala", "Artem Dovbyk"],
  roma: ["Paulo Dybala", "Artem Dovbyk"],
  "al-nassr": ["Cristiano Ronaldo", "Sadio Mane"],
  "inter miami": ["Lionel Messi", "Luis Suarez"],
  nigeria: ["Victor Osimhen", "Ademola Lookman", "Alex Iwobi"],
  england: ["Jude Bellingham", "Bukayo Saka", "Harry Kane"],
  france: ["Kylian Mbappe", "Ousmane Dembele", "Antoine Griezmann"],
  brazil: ["Vinicius Junior", "Rodrygo", "Raphinha"],
  argentina: ["Lionel Messi", "Lautaro Martinez", "Julian Alvarez"],
  spain: ["Lamine Yamal", "Rodri", "Pedri"],
  germany: ["Jamal Musiala", "Florian Wirtz", "Joshua Kimmich"],
  portugal: ["Cristiano Ronaldo", "Bruno Fernandes", "Rafael Leao"],
  netherlands: ["Virgil van Dijk", "Cody Gakpo"],
  italy: ["Nicolo Barella", "Gianluigi Donnarumma"],
};

const NATIONAL_FLAG_ISO: Record<string, string> = {
  algeria: "dz",
  angola: "ao",
  argentina: "ar",
  australia: "au",
  austria: "at",
  belgium: "be",
  bolivia: "bo",
  brazil: "br",
  "burkina faso": "bf",
  cameroon: "cm",
  canada: "ca",
  "cape verde": "cv",
  chile: "cl",
  china: "cn",
  colombia: "co",
  "costa rica": "cr",
  croatia: "hr",
  "czech republic": "cz",
  czechia: "cz",
  denmark: "dk",
  "dr congo": "cd",
  ecuador: "ec",
  egypt: "eg",
  england: "gb-eng",
  ethiopia: "et",
  finland: "fi",
  france: "fr",
  germany: "de",
  ghana: "gh",
  greece: "gr",
  guinea: "gn",
  honduras: "hn",
  hungary: "hu",
  iceland: "is",
  india: "in",
  iran: "ir",
  ireland: "ie",
  israel: "il",
  italy: "it",
  "ivory coast": "ci",
  "cote d ivoire": "ci",
  jamaica: "jm",
  japan: "jp",
  kenya: "ke",
  mali: "ml",
  mexico: "mx",
  morocco: "ma",
  netherlands: "nl",
  "new zealand": "nz",
  nigeria: "ng",
  "northern ireland": "gb-nir",
  norway: "no",
  panama: "pa",
  paraguay: "py",
  peru: "pe",
  poland: "pl",
  portugal: "pt",
  qatar: "qa",
  "republic of ireland": "ie",
  romania: "ro",
  russia: "ru",
  "saudi arabia": "sa",
  scotland: "gb-sct",
  senegal: "sn",
  serbia: "rs",
  slovakia: "sk",
  slovenia: "si",
  "south africa": "za",
  "south korea": "kr",
  spain: "es",
  sweden: "se",
  switzerland: "ch",
  tanzania: "tz",
  tunisia: "tn",
  turkey: "tr",
  turkiye: "tr",
  uae: "ae",
  uganda: "ug",
  ukraine: "ua",
  "united arab emirates": "ae",
  uruguay: "uy",
  usa: "us",
  "united states": "us",
  venezuela: "ve",
  wales: "gb-wls",
  zambia: "zm",
  zimbabwe: "zw",
};

export function normalizeTeamName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .replace(/\b(fc|afc|cf|sc|ac|as|ss|rc|cd|ud|fk|sk|nk|bk|ik|rb)\b/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTeamNameMatch(candidate: string | null | undefined, target: string): boolean {
  if (!candidate) return false;
  const a = normalizeTeamName(candidate);
  const b = normalizeTeamName(target);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const targetAliases = TEAM_SEARCH_ALIASES[target.toLowerCase().trim()] ?? [];
  const candidateAliases = TEAM_SEARCH_ALIASES[candidate.toLowerCase().trim()] ?? [];

  if (
    targetAliases.some((alias) => {
      const normAlias = normalizeTeamName(alias);
      return Boolean(normAlias) && (a === normAlias || a.includes(normAlias) || normAlias.includes(a));
    })
  ) {
    return true;
  }

  return candidateAliases.some((alias) => {
    const normAlias = normalizeTeamName(alias);
    return Boolean(normAlias) && (b === normAlias || b.includes(normAlias) || normAlias.includes(b));
  });
}

export function getNationalFlagUrl(teamName: string): string | null {
  const raw = teamName.toLowerCase().trim();
  const iso = NATIONAL_FLAG_ISO[raw] ?? NATIONAL_FLAG_ISO[normalizeTeamName(teamName)];
  return iso ? `https://flagcdn.com/w80/${iso}.png` : null;
}

function teamPrestigeScore(name: string): number {
  const norm = normalizeTeamName(name);
  if (TIER_1_TEAMS.has(norm)) return 120;
  if (TIER_2_TEAMS.has(norm)) return 60;
  return 0;
}

function competitivenessScore(event: EventView): number {
  const oneXTwo = event.markets.find((m) => m.key === "1x2");
  if (!oneXTwo) return 0;
  const home = oneXTwo.selections.find((s) => s.key === "home")?.price;
  const away = oneXTwo.selections.find((s) => s.key === "away")?.price;
  if (!home || !away || home <= 1 || away <= 1) return 0;
  const diff = Math.abs(1 / home - 1 / away);
  return Math.max(0, Math.round(40 * (1 - Math.min(1, diff / 0.7))));
}

export function scoreHotMatch(event: EventView, nowMs = Date.now()): number {
  let score = 0;

  if (event.status === "LIVE") {
    score += 1000;
  }

  score += teamPrestigeScore(event.home);
  score += teamPrestigeScore(event.away);

  if (HOT_LEAGUES.has(event.league.trim().toLowerCase())) {
    score += 60;
  }

  score += Math.min(30, event.markets.length * 8);
  score += competitivenessScore(event);

  const startsMs = Date.parse(event.startsAt);
  if (Number.isFinite(startsMs)) {
    const hoursAway = (startsMs - nowMs) / (1000 * 60 * 60);
    if (hoursAway <= 48) score += 60;
    else if (hoursAway <= 120) score += 40;
    else if (hoursAway <= 240) score += 20;
  }

  return score;
}

/**
 * Picks the hottest fixture on the board:
 * LIVE matches always take priority, followed by marquee club rivalries,
 * competition tier, competitive odds, market depth, and near-term kickoff.
 */
export function pickHottestMatch(events: EventView[], nowMs = Date.now()): EventView | null {
  if (events.length === 0) return null;

  let best = events[0]!;
  let bestScore = scoreHotMatch(best, nowMs);

  for (let i = 1; i < events.length; i += 1) {
    const candidate = events[i]!;
    const candidateScore = scoreHotMatch(candidate, nowMs);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    } else if (candidateScore === bestScore) {
      const a = Date.parse(candidate.startsAt);
      const b = Date.parse(best.startsAt);
      if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
        best = candidate;
      }
    }
  }

  return best;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 2800): Promise<T | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 21600 },
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text || text.trimStart().startsWith("<")) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/* ==========================================================================
   FREE CLUB CRESTS CATALOG (ESPN Global API — zero key, 500x500 PNGs)
   ========================================================================== */

const ESPN_SOCCER_LEAGUES = [
  "eng.1",
  "eng.2",
  "eng.fa",
  "esp.1",
  "esp.2",
  "ger.1",
  "ita.1",
  "fra.1",
  "por.1",
  "ned.1",
  "tur.1",
  "sco.1",
  "bel.1",
  "ksa.1",
  "bra.1",
  "arg.1",
  "mex.1",
  "usa.1",
  "uefa.champions",
  "uefa.europa",
  "uefa.europa.conf",
  "conmebol.libertadores",
  "fifa.world",
  "uefa.euro",
  "caf.nations",
];

const ESPN_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const espnCatalogPromises = new Map<string, { promise: Promise<Map<string, string>>; expiresAt: number }>();

interface EspnTeamsResponse {
  sports?: {
    leagues?: {
      teams?: {
        team?: {
          displayName?: string;
          shortDisplayName?: string;
          nickname?: string;
          logos?: { href?: string }[];
        };
      }[];
    }[];
  }[];
}

async function loadEspnBadges(sport = "football"): Promise<Map<string, string>> {
  const sportKey = sport.toLowerCase() === "basketball" ? "basketball" : "soccer";
  const now = Date.now();
  const cached = espnCatalogPromises.get(sportKey);
  if (cached && now < cached.expiresAt) {
    return cached.promise;
  }

  const paths =
    sportKey === "basketball"
      ? ["basketball/nba"]
      : ESPN_SOCCER_LEAGUES.map((slug) => `soccer/${slug}`);

  const promise = (async () => {
    const index = new Map<string, string>();
    const results = await Promise.all(
      paths.map((path) =>
        fetchJsonWithTimeout<EspnTeamsResponse>(
          `https://site.api.espn.com/apis/site/v2/sports/${path}/teams`,
          3000,
        ),
      ),
    );

    for (const payload of results) {
      const entries = payload?.sports?.[0]?.leagues?.[0]?.teams ?? [];
      for (const entry of entries) {
        const team = entry.team;
        const logo = team?.logos?.[0]?.href?.trim();
        if (!team || !logo) continue;

        for (const candidate of [team.displayName, team.shortDisplayName, team.nickname]) {
          if (!candidate) continue;
          const lower = candidate.toLowerCase().trim();
          const norm = normalizeTeamName(candidate);
          if (lower && !index.has(lower)) index.set(lower, logo);
          if (norm && !index.has(norm)) index.set(norm, logo);
        }
      }
    }

    if (index.size === 0) {
      espnCatalogPromises.delete(sportKey);
    }
    return index;
  })();

  espnCatalogPromises.set(sportKey, {
    promise,
    expiresAt: now + ESPN_CATALOG_TTL_MS,
  });

  return promise;
}

export function lookupEspnBadgeFromMap(teamName: string, map: Map<string, string>): string | null {
  const raw = teamName.toLowerCase().trim();
  const norm = normalizeTeamName(teamName);
  const andAmp = raw.replace(/\band\b/g, "&");
  const strippedSuffix = norm
    .replace(/\s+(city|united|town|hotspur|rovers|wanderers|albion)$/i, "")
    .trim();

  const candidates = [
    raw,
    andAmp,
    norm,
    ...(TEAM_SEARCH_ALIASES[raw] ?? []).flatMap((a) => [a.toLowerCase().trim(), normalizeTeamName(a)]),
    strippedSuffix,
  ];

  for (const key of candidates) {
    if (!key) continue;
    const hit = map.get(key);
    if (hit) return hit;
  }
  return null;
}

const BOARD_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;
const BOARD_FALLBACK_MISS_TTL_MS = 15 * 60 * 1000;
const boardBadgeFallbackCache = new Map<string, { url: string | null; expiresAt: number }>();

async function lookupFallbackBadge(teamName: string, sport: string): Promise<string | null> {
  const cacheKey = `${sport.toLowerCase()}:${normalizeTeamName(teamName)}`;
  const cached = boardBadgeFallbackCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const apiKey = process.env.THESPORTSDB_API_KEY?.trim() || "123";
  const targetSport = sportMatchFor(sport);
  const data = await fetchJsonWithTimeout<{ teams?: SportsDbTeam[] | null }>(
    `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey)}/searchteams.php?t=${encodeURIComponent(teamName)}`,
    2200,
  );

  const list = data?.teams ?? [];
  const matched =
    (targetSport
      ? list.find((t) => (t.strSport ?? "").toLowerCase() === targetSport.toLowerCase())
      : null) ?? list[0];
  const url = matched?.strBadge?.trim() || null;

  boardBadgeFallbackCache.set(cacheKey, {
    url,
    expiresAt: Date.now() + (url ? BOARD_FALLBACK_TTL_MS : BOARD_FALLBACK_MISS_TTL_MS),
  });
  return url;
}

/**
 * Resolves free 500x500 club crests (ESPN 25-league catalog) and national flags
 * (FlagCDN) for all teams on the board, plus cached TheSportsDB fallback for any
 * newly synced club outside the global ESPN catalog.
 */
export async function resolveBoardBadges(events: EventView[]): Promise<Record<string, string>> {
  if (events.length === 0) return {};

  const primarySport = events[0]?.sport ?? "football";
  const badgeMap = await loadEspnBadges(primarySport).catch(() => new Map<string, string>());
  const out: Record<string, string> = {};
  const unresolved: { team: string; sport: string }[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    for (const team of [event.home, event.away]) {
      if (seen.has(team)) continue;
      seen.add(team);

      const flag = getNationalFlagUrl(team);
      if (flag) {
        out[team] = flag;
        continue;
      }

      const espn = lookupEspnBadgeFromMap(team, badgeMap);
      if (espn) {
        out[team] = espn;
        continue;
      }

      unresolved.push({ team, sport: event.sport });
    }
  }

  // Fallback sequentially (capped to 4 distinct lookups per render) to avoid
  // free-tier rate limits while seamlessly supporting newly synced teams.
  for (const item of unresolved.slice(0, 4)) {
    const found = await lookupFallbackBadge(item.team, item.sport);
    if (found) out[item.team] = found;
  }

  return out;
}

/* ==========================================================================
   FEATURED HERO VISUALS (ESPN / FlagCDN Crests + TheSportsDB Player Renders)
   ========================================================================== */

interface CacheEntry {
  value: TeamVisual;
  expiresAt: number;
}

const TEAM_VISUAL_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const teamVisualCache = new Map<string, CacheEntry>();

function sportMatchFor(sport: string): string {
  const s = sport.toLowerCase();
  if (s === "football" || s === "soccer") return "Soccer";
  if (s === "basketball") return "Basketball";
  if (s === "tennis") return "Tennis";
  return "";
}

interface SportsDbTeam {
  idTeam?: string | null;
  strTeam?: string | null;
  strSport?: string | null;
  strBadge?: string | null;
}

interface SportsDbPlayer {
  strPlayer?: string | null;
  strTeam?: string | null;
  strSport?: string | null;
  strPosition?: string | null;
  strRender?: string | null;
  strCutout?: string | null;
}

function positionWeight(position: string | null | undefined): number {
  const p = (position ?? "").toLowerCase();
  if (!p) return 10;
  if (p.includes("manager") || p.includes("coach")) return -100;
  if (p.includes("forward") || p.includes("striker") || p.includes("wing")) return 50;
  if (p.includes("midfield")) return 35;
  if (p.includes("back") || p.includes("defend")) return 20;
  if (p.includes("goalkeeper") || p.includes("keeper")) return 5;
  return 15;
}

export function pickMatchingStarPlayer(
  players: SportsDbPlayer[],
  teamName: string,
  sport: string,
): { url: string; name: string | null } | null {
  const targetSport = sportMatchFor(sport).toLowerCase();
  for (const player of players) {
    if (targetSport && player.strSport && player.strSport.toLowerCase() !== targetSport) {
      continue;
    }
    if (!isTeamNameMatch(player.strTeam, teamName)) {
      continue;
    }
    const url = player.strRender?.trim() || player.strCutout?.trim() || null;
    if (url) {
      return { url, name: player.strPlayer?.trim() || null };
    }
  }
  return null;
}

function pickBestPlayer(
  players: SportsDbPlayer[],
  starNames: string[],
): { url: string; name: string | null } | null {
  if (starNames.length > 0) {
    for (const star of starNames) {
      const starLower = star.toLowerCase();
      const hit = players.find((p) => {
        const name = (p.strPlayer ?? "").toLowerCase();
        const url = p.strRender?.trim() || p.strCutout?.trim();
        return Boolean(url) && (name === starLower || name.includes(starLower));
      });
      if (hit) {
        const url = hit.strRender?.trim() || hit.strCutout?.trim() || null;
        if (url) return { url, name: hit.strPlayer?.trim() || null };
      }
    }
  }

  let best: { url: string; name: string | null; score: number } | null = null;

  for (const player of players) {
    const posScore = positionWeight(player.strPosition);
    if (posScore < 0) continue;

    const render = player.strRender?.trim() || null;
    const cutout = player.strCutout?.trim() || null;
    const url = render ?? cutout;
    if (!url) continue;

    const imageScore = render ? 100 : 40;
    const total = imageScore + posScore;

    if (!best || total > best.score) {
      best = {
        url,
        name: player.strPlayer?.trim() || null,
        score: total,
      };
    }
  }

  return best ? { url: best.url, name: best.name } : null;
}

export async function resolveTeamVisual(teamName: string, sport: string): Promise<TeamVisual> {
  const normKey = `${sport.toLowerCase()}:${normalizeTeamName(teamName)}`;
  const cached = teamVisualCache.get(normKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const flagBadge = getNationalFlagUrl(teamName);
  const espnBadges = await loadEspnBadges(sport).catch(() => new Map<string, string>());
  const espnBadge = flagBadge ? null : lookupEspnBadgeFromMap(teamName, espnBadges);

  const apiKey = process.env.THESPORTSDB_API_KEY?.trim() || "123";
  const targetSport = sportMatchFor(sport);
  const aliases = TEAM_SEARCH_ALIASES[teamName.toLowerCase().trim()] ?? [];
  const queries = [...new Set([teamName, ...aliases])];

  let matchedTeam: SportsDbTeam | null = null;

  for (const query of queries) {
    const data = await fetchJsonWithTimeout<{ teams?: SportsDbTeam[] | null }>(
      `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey)}/searchteams.php?t=${encodeURIComponent(query)}`,
    );
    const list = data?.teams ?? [];
    if (list.length === 0) continue;

    matchedTeam =
      (targetSport
        ? list.find((t) => (t.strSport ?? "").toLowerCase() === targetSport.toLowerCase())
        : null) ?? list[0]!;
    if (matchedTeam?.idTeam) break;
  }

  const normTeam = normalizeTeamName(teamName);
  const starNames =
    STAR_PLAYERS_BY_TEAM[teamName.toLowerCase().trim()] ??
    STAR_PLAYERS_BY_TEAM[normTeam] ??
    [];

  let squadPlayers: SportsDbPlayer[] = [];
  if (matchedTeam?.idTeam) {
    const playersData = await fetchJsonWithTimeout<{ player?: SportsDbPlayer[] | null }>(
      `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey)}/lookup_all_players.php?id=${encodeURIComponent(matchedTeam.idTeam)}`,
    );
    squadPlayers = playersData?.player ?? [];
  }

  // First check whether any curated star already appears in the club squad
  // payload (which preserves higher-resolution full-body `strRender` PNGs).
  let player: { url: string; name: string | null } | null = null;
  if (starNames.length > 0 && squadPlayers.length > 0) {
    const squadStar = squadPlayers.find((p) => {
      const n = (p.strPlayer ?? "").toLowerCase();
      return (
        Boolean(p.strRender?.trim() || p.strCutout?.trim()) &&
        starNames.some((s) => n === s.toLowerCase() || n.includes(s.toLowerCase()))
      );
    });
    if (squadStar) {
      const url = squadStar.strRender?.trim() || squadStar.strCutout?.trim() || null;
      if (url) player = { url, name: squadStar.strPlayer?.trim() || null };
    }
  }

  // If the club's 10-player alphabetical list didn't include a star (e.g. Haaland),
  // query TheSportsDB player search and verify they belong to this exact club.
  if (!player && starNames.length > 0) {
    for (const star of starNames.slice(0, 2)) {
      const searchData = await fetchJsonWithTimeout<{ player?: SportsDbPlayer[] | null }>(
        `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey)}/searchplayers.php?p=${encodeURIComponent(star)}`,
      );
      const hit = pickMatchingStarPlayer(searchData?.player ?? [], teamName, sport);
      if (hit) {
        player = hit;
        break;
      }
    }
  }

  // Generic automatic fallback for any future club or national team
  if (!player && squadPlayers.length > 0) {
    player = pickBestPlayer(squadPlayers, starNames);
  }

  const badgeUrl = flagBadge ?? espnBadge ?? matchedTeam?.strBadge?.trim() ?? null;
  const source: TeamVisual["source"] = matchedTeam?.idTeam
    ? "thesportsdb"
    : flagBadge
      ? "flagcdn"
      : espnBadge
        ? "espn"
        : "none";

  const result: TeamVisual = {
    teamName,
    badgeUrl,
    playerImageUrl: player?.url ?? null,
    playerName: player?.name ?? null,
    source,
  };

  teamVisualCache.set(normKey, {
    value: result,
    expiresAt: Date.now() + (source === "none" ? NEGATIVE_TTL_MS : TEAM_VISUAL_TTL_MS),
  });
  return result;
}

export async function resolveMatchVisuals(event: EventView): Promise<MatchVisuals> {
  const [home, away] = await Promise.all([
    resolveTeamVisual(event.home, event.sport),
    resolveTeamVisual(event.away, event.sport),
  ]);
  return { home, away };
}
