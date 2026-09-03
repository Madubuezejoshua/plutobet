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
 *  2. Honesty. Some of these products do not exist yet. `status` records that
 *     fact in one place, so a link to an unbuilt product renders as a labelled
 *     placeholder rather than a dead route. Fake buttons and empty pages are
 *     forbidden; this is the mechanism that enforces it.
 *
 *  3. Pluto AI. The model must not be
 *     allowed to invent internal URLs — it may only navigate to a destination
 *     that exists in a registry. That registry is this file. Building it now
 *     means the AI navigation tool is a lookup against known-good keys rather
 *     than a language model emitting a path and hoping.
 */

export type ProductStatus =
  /** Built, reachable, and doing real work. */
  | "LIVE"
  /**
   * The route exists and says plainly that the product is not available yet.
   *
   * It does NOT name a delivery date. An internal build-phase number told a
   * customer nothing and read as a commitment we had not made.
   */
  | "PLANNED";

export interface NavItem {
  /** Stable identifier. This is what Pluto AI will navigate by, never the path. */
  key: string;
  label: string;
  href: string;
  status: ProductStatus;
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
    status: "LIVE",
    blurb: "Everything happening on PlutoBet right now.",
    group: "BETTING",
  },
  {
    key: "sports",
    label: "Sports",
    href: "/sports",
    status: "LIVE",
    blurb: "Pre-match football odds. Singles and accumulators.",
    group: "BETTING",
  },
  {
    key: "live",
    label: "Live",
    href: "/live",
    status: "LIVE",
    blurb: "Live scores and prices, refreshed automatically.",
    group: "BETTING",
  },
  {
    key: "jackpot",
    label: "Jackpot",
    href: "/jackpot",
    status: "LIVE",
    blurb: "Predict a full slate of fixtures for a pooled prize.",
    group: "BETTING",
  },

  // ----------------------------------------------------------------- gaming
  {
    key: "casino",
    label: "Casino",
    href: "/casino",
    status: "LIVE",
    blurb: "Slots, table games, crash and instant games.",
    group: "GAMING",
  },
  {
    key: "live-casino",
    label: "Live Casino",
    href: "/live-casino",
    status: "PLANNED",
    blurb: "Real dealers, streamed in real time.",
    group: "GAMING",
  },
  {
    key: "virtuals",
    label: "Virtuals",
    href: "/virtuals",
    status: "LIVE",
    blurb: "Simulated football, racing and instant draws.",
    group: "GAMING",
  },
  {
    key: "fantasy",
    label: "Fantasy",
    href: "/fantasy",
    status: "PLANNED",
    blurb: "Build a squad, score against other players.",
    group: "GAMING",
  },
  {
    key: "lucky-numbers",
    label: "Lucky Numbers",
    href: "/lucky-numbers",
    status: "PLANNED",
    blurb: "Draw-based number games.",
    group: "GAMING",
  },

  // ------------------------------------------------------------------- info
  {
    key: "livescore",
    label: "Livescore",
    href: "/livescore",
    status: "LIVE",
    blurb: "Scores, clocks and match events. No bet required.",
    group: "INFO",
  },
  {
    key: "results",
    label: "Results",
    href: "/results",
    status: "LIVE",
    blurb: "Completed fixtures, searchable by date and team.",
    group: "INFO",
  },
  {
    key: "promotions",
    label: "Promotions",
    href: "/promotions",
    status: "LIVE",
    blurb: "Bonuses, free bets and seasonal offers.",
    group: "INFO",
  },
  {
    key: "rewards",
    label: "Rewards",
    href: "/rewards",
    status: "LIVE",
    blurb: "Loyalty tiers and everything they unlock.",
    group: "INFO",
  },
  {
    key: "pluto-ai",
    label: "Pluto AI",
    href: "/pluto",
    status: "LIVE",
    blurb: "Ask for fixtures, analysis, or your balance in plain language.",
    group: "INFO",
  },

  // ---------------------------------------------------------------- account
  {
    key: "bets",
    label: "My Bets",
    href: "/bets",
    status: "LIVE",
    blurb: "Open and settled tickets, at the odds you locked in.",
    requiresAuth: true,
    group: "ACCOUNT",
  },
  {
    key: "wallet",
    label: "Wallet",
    href: "/wallet",
    status: "LIVE",
    blurb: "Balance and full transaction statement.",
    requiresAuth: true,
    group: "ACCOUNT",
  },
  {
    key: "account",
    label: "Account",
    href: "/account",
    status: "LIVE",
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
  signIn: "/signin",
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
