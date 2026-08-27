/**
 * The navigation registry.
 *
 * Every internal destination in PlutoBet is declared here once. Nothing else
 * in the codebase should hard-code an application path.
 *
 * WHY A REGISTRY AND NOT JUST <a href="/sports">
 *
 * Three reasons, in increasing order of importance:
 *
 *  1. Consistency. Seventeen product areas appear in the desktop header, the
 *     mobile drawer, the mobile bottom bar, the homepage and the footer. One
 *     list means they cannot drift apart.
 *
 *  2. Honesty. Most of these products do not exist yet. `status` records that
 *     fact in one place, so a link to an unbuilt product renders as a labelled
 *     placeholder rather than a dead route. The master spec forbids fake
 *     buttons and empty pages; this is the mechanism that enforces it.
 *
 *  3. Pluto AI (Phase 17.7). The spec is explicit that the model must not be
 *     allowed to invent internal URLs — it may only navigate to a destination
 *     that exists in a registry. That registry is this file. Building it now
 *     means the AI navigation tool is a lookup against known-good keys rather
 *     than a language model emitting a path and hoping.
 */

export type ProductStatus =
  /** Built, reachable, and doing real work. */
  | "LIVE"
  /** Route exists and renders an honest placeholder naming the phase. */
  | "PLANNED";

export interface NavItem {
  /** Stable identifier. This is what Pluto AI will navigate by, never the path. */
  key: string;
  label: string;
  href: string;
  /** Single glyph for the mobile bar and menu. Text label always accompanies it. */
  icon: string;
  status: ProductStatus;
  /** Phase from the master build prompt that delivers this. Shown on placeholders. */
  phase: number;
  /** One line describing the product, used on placeholders and the homepage. */
  blurb: string;
  /** Redirects to sign-in when there is no session. */
  requiresAuth?: boolean;
  /** Grouping for the mobile drawer. */
  group: "BETTING" | "GAMING" | "INFO" | "ACCOUNT";
}

export const NAV_ITEMS: readonly NavItem[] = [
  // ---------------------------------------------------------------- betting
  {
    key: "home",
    label: "Home",
    href: "/",
    icon: "🏠",
    status: "LIVE",
    phase: 1,
    blurb: "Everything happening on PlutoBet right now.",
    group: "BETTING",
  },
  {
    key: "sports",
    label: "Sports",
    href: "/sports",
    icon: "⚽",
    status: "LIVE",
    phase: 8,
    blurb: "Pre-match football odds. Singles and accumulators.",
    group: "BETTING",
  },
  {
    key: "live",
    label: "Live",
    href: "/live",
    icon: "🔴",
    status: "LIVE",
    phase: 9,
    blurb: "Live scores and prices, refreshed automatically.",
    group: "BETTING",
  },
  {
    key: "jackpot",
    label: "Jackpot",
    href: "/jackpot",
    icon: "🏆",
    status: "LIVE",
    phase: 13,
    blurb: "Predict a full slate of fixtures for a pooled prize.",
    group: "BETTING",
  },

  // ----------------------------------------------------------------- gaming
  {
    key: "casino",
    label: "Casino",
    href: "/casino",
    icon: "🎰",
    status: "LIVE",
    phase: 11,
    blurb: "Slots, table games, crash and instant games.",
    group: "GAMING",
  },
  {
    key: "live-casino",
    label: "Live Casino",
    href: "/live-casino",
    icon: "🃏",
    status: "PLANNED",
    phase: 11,
    blurb: "Real dealers, streamed in real time.",
    group: "GAMING",
  },
  {
    key: "virtuals",
    label: "Virtuals",
    href: "/virtuals",
    icon: "🎮",
    status: "LIVE",
    phase: 12,
    blurb: "Simulated football, racing and instant draws.",
    group: "GAMING",
  },
  {
    key: "fantasy",
    label: "Fantasy",
    href: "/fantasy",
    icon: "👥",
    status: "PLANNED",
    phase: 13,
    blurb: "Build a squad, score against other players.",
    group: "GAMING",
  },
  {
    key: "lucky-numbers",
    label: "Lucky Numbers",
    href: "/lucky-numbers",
    icon: "🔢",
    status: "PLANNED",
    phase: 13,
    blurb: "Draw-based number games.",
    group: "GAMING",
  },

  // ------------------------------------------------------------------- info
  {
    key: "livescore",
    label: "Livescore",
    href: "/livescore",
    icon: "📊",
    status: "LIVE",
    phase: 10,
    blurb: "Scores, clocks and match events. No bet required.",
    group: "INFO",
  },
  {
    key: "results",
    label: "Results",
    href: "/results",
    icon: "📋",
    status: "LIVE",
    phase: 10,
    blurb: "Completed fixtures, searchable by date and team.",
    group: "INFO",
  },
  {
    key: "promotions",
    label: "Promotions",
    href: "/promotions",
    icon: "🎁",
    status: "LIVE",
    phase: 14,
    blurb: "Bonuses, free bets and seasonal offers.",
    group: "INFO",
  },
  {
    key: "rewards",
    label: "Rewards",
    href: "/rewards",
    icon: "💎",
    status: "LIVE",
    phase: 14,
    blurb: "Loyalty tiers and everything they unlock.",
    group: "INFO",
  },
  {
    key: "pluto-ai",
    label: "Pluto AI",
    href: "/pluto",
    icon: "✨",
    status: "LIVE",
    phase: 16,
    blurb: "Ask for fixtures, analysis, or your balance in plain language.",
    group: "INFO",
  },

  // ---------------------------------------------------------------- account
  {
    key: "bets",
    label: "My Bets",
    href: "/bets",
    icon: "🎫",
    status: "LIVE",
    phase: 8,
    blurb: "Open and settled tickets, at the odds you locked in.",
    requiresAuth: true,
    group: "ACCOUNT",
  },
  {
    key: "wallet",
    label: "Wallet",
    href: "/wallet",
    icon: "👛",
    status: "LIVE",
    phase: 4,
    blurb: "Balance and full transaction statement.",
    requiresAuth: true,
    group: "ACCOUNT",
  },
  {
    key: "account",
    label: "Account",
    href: "/account",
    icon: "👤",
    status: "LIVE",
    phase: 2,
    blurb: "Profile, verification and responsible gambling controls.",
    requiresAuth: true,
    group: "ACCOUNT",
  },
] as const;

/** Secondary destinations: real pages, but not top-level products. */
export const UTILITY_ROUTES = {
  deposit: "/deposit",
  withdraw: "/withdraw",
  verify: "/kyc",
  responsible: "/responsible",
  register: "/register",
  signIn: "/api/auth/signin",
  signOut: "/api/auth/signout",
} as const;

export type UtilityRouteKey = keyof typeof UTILITY_ROUTES;

/**
 * The mobile bottom bar.
 *
 * Five entries, because a sixth stops being tappable on a 360px screen — the
 * low-bandwidth Android target this product is aimed at. "Betslip" is not a
 * page: it opens the slip the user is already building, so it is handled by
 * the mobile nav component rather than resolved here.
 */
export const MOBILE_BAR_KEYS = ["home", "sports", "__betslip__", "bets", "account"] as const;

export function navItem(key: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.key === key);
}

export function navByGroup(group: NavItem["group"]): NavItem[] {
  return NAV_ITEMS.filter((item) => item.group === group);
}

/** Products that actually work. Used to avoid promoting placeholders. */
export function liveProducts(): NavItem[] {
  return NAV_ITEMS.filter((item) => item.status === "LIVE" && item.key !== "home");
}

/**
 * Resolves a path to its registry entry.
 *
 * Longest match wins so `/admin/kyc` does not resolve to `/admin`, and the
 * root path only ever matches itself.
 */
export function navItemForPath(pathname: string): NavItem | undefined {
  if (pathname === "/") return navItem("home");
  return NAV_ITEMS.filter((item) => item.href !== "/")
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
