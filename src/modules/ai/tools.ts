import type { Permission } from "../admin/permissions";

/**
 * The AI tool registry.
 *
 * THE SINGLE MOST IMPORTANT FILE IN THE AI LAYER.
 *
 * Rule 12 of the build spec: "Pluto AI must NEVER receive unrestricted database
 * access." This registry is how that is enforced rather than promised. The
 * model cannot query, cannot write SQL, and cannot reach a service directly. It
 * can only name a tool from this list, and the runtime decides whether that
 * name is allowed and what it is permitted to see.
 *
 * FOUR ACTION LEVELS, from the spec:
 *
 *   READ      fixtures, odds, statistics, balance. No confirmation.
 *   ACCOUNT   preferences, favourites. Confirm when it matters.
 *   FINANCIAL place a bet, cash out, deposit, withdraw. ALWAYS confirmed.
 *   HIGH_RISK large withdrawal, payout details, security changes. Confirmed
 *             AND re-authenticated.
 *
 * WHY LEVEL LIVES ON THE TOOL AND NOT IN THE PROMPT
 * A level expressed in a system prompt is a request. A level attached to the
 * tool definition is a fact the runtime checks before dispatching. Prompts get
 * talked around; a switch statement does not.
 */

export type ActionLevel = "READ" | "ACCOUNT" | "FINANCIAL" | "HIGH_RISK";

export interface ToolDefinition {
  name: string;
  description: string;
  level: ActionLevel;
  /** Requires a signed-in customer. READ tools over public data do not. */
  requiresAuth: boolean;
  /**
   * Reads or writes THIS customer's data only.
   *
   * Every tool so marked receives the session's user id from the runtime and
   * has no parameter for it. The model cannot name a user, so it cannot ask
   * about somebody else's — the isolation is structural rather than a rule the
   * model is asked to follow.
   */
  scopedToUser: boolean;
  /** Admin-only tools additionally require this permission. */
  adminPermission?: Permission;
  parameters: Record<string, { type: "string" | "number" | "boolean"; description: string; required?: boolean }>;
}

export const AI_TOOLS: readonly ToolDefinition[] = [
  // ---------------------------------------------------------------- READ
  {
    name: "findFixtures",
    description: "Find upcoming fixtures by team, competition or day.",
    level: "READ",
    requiresAuth: false,
    scopedToUser: false,
    parameters: {
      query: { type: "string", description: "Team or competition name" },
      day: { type: "string", description: "today, tomorrow, or YYYY-MM-DD" },
    },
  },
  {
    name: "getOdds",
    description: "Current prices for one fixture.",
    level: "READ",
    requiresAuth: false,
    scopedToUser: false,
    parameters: {
      eventId: { type: "string", description: "Fixture id", required: true },
    },
  },
  {
    name: "getLiveEvents",
    description: "Fixtures currently in play, with scores.",
    level: "READ",
    requiresAuth: false,
    scopedToUser: false,
    parameters: {},
  },
  {
    name: "getHeadToHead",
    description: "Past meetings between two teams.",
    level: "READ",
    requiresAuth: false,
    scopedToUser: false,
    parameters: {
      eventId: { type: "string", description: "Fixture id", required: true },
    },
  },
  {
    name: "explainMarket",
    description: "Explain what a betting market means in plain language.",
    level: "READ",
    requiresAuth: false,
    scopedToUser: false,
    parameters: {
      market: { type: "string", description: "Market key, e.g. over_under", required: true },
    },
  },
  {
    name: "getBalance",
    description: "The signed-in customer's own balance.",
    level: "READ",
    requiresAuth: true,
    scopedToUser: true,
    parameters: {},
  },
  {
    name: "getMyBets",
    description: "The signed-in customer's own open and settled bets.",
    level: "READ",
    requiresAuth: true,
    scopedToUser: true,
    parameters: {
      status: { type: "string", description: "open or settled" },
    },
  },
  {
    name: "getMyTransactions",
    description: "The signed-in customer's own recent wallet activity.",
    level: "READ",
    requiresAuth: true,
    scopedToUser: true,
    parameters: {
      limit: { type: "number", description: "How many, up to 25" },
    },
  },
  {
    name: "getPromotions",
    description: "Promotions currently running.",
    level: "READ",
    requiresAuth: false,
    scopedToUser: false,
    parameters: {},
  },
  {
    name: "navigate",
    description:
      "Take the customer to a page. Only destinations in the navigation registry are valid.",
    level: "READ",
    requiresAuth: false,
    scopedToUser: false,
    parameters: {
      destination: { type: "string", description: "A navigation key, e.g. sports", required: true },
    },
  },

  // ------------------------------------------------------------- ACCOUNT
  {
    name: "setOddsFormat",
    description: "Change how prices are displayed for this customer.",
    level: "ACCOUNT",
    requiresAuth: true,
    scopedToUser: true,
    parameters: {
      format: { type: "string", description: "DECIMAL, FRACTIONAL or AMERICAN", required: true },
    },
  },
  {
    name: "setDepositLimit",
    description: "Set a responsible-gambling deposit limit.",
    level: "ACCOUNT",
    requiresAuth: true,
    scopedToUser: true,
    parameters: {
      amountNaira: { type: "number", description: "Limit in naira", required: true },
      periodDays: { type: "number", description: "1, 7 or 30", required: true },
    },
  },

  // ----------------------------------------------------------- FINANCIAL
  {
    name: "prepareBet",
    description:
      "Build a bet slip for the customer to review. Does NOT place it — placing always needs explicit confirmation.",
    level: "FINANCIAL",
    requiresAuth: true,
    scopedToUser: true,
    parameters: {
      selectionIds: { type: "string", description: "Comma-separated selection ids", required: true },
      stakeNaira: { type: "number", description: "Stake in naira", required: true },
    },
  },
  {
    name: "prepareWithdrawal",
    description:
      "Prepare a withdrawal for the customer to review. Does NOT send money.",
    level: "HIGH_RISK",
    requiresAuth: true,
    scopedToUser: true,
    parameters: {
      amountNaira: { type: "number", description: "Amount in naira", required: true },
    },
  },
] as const;

export function findTool(name: string): ToolDefinition | undefined {
  return AI_TOOLS.find((tool) => tool.name === name);
}

/**
 * Whether a tool's result must be confirmed by the customer before anything
 * happens.
 *
 * Rules 13 and 14: the AI may prepare a bet or a withdrawal, and may never
 * complete one. Every FINANCIAL and HIGH_RISK tool therefore returns a DRAFT,
 * and the customer confirms it through the ordinary product flow — the same
 * path, with the same checks, as if they had built it by hand.
 */
export function requiresConfirmation(level: ActionLevel): boolean {
  return level === "FINANCIAL" || level === "HIGH_RISK";
}

/** Whether the customer must re-enter their password first. */
export function requiresReauthentication(level: ActionLevel): boolean {
  return level === "HIGH_RISK";
}

/** Tools available to an anonymous visitor: public reads only. */
export function publicTools(): ToolDefinition[] {
  return AI_TOOLS.filter((tool) => !tool.requiresAuth);
}

export function toolsFor(signedIn: boolean): ToolDefinition[] {
  return signedIn ? [...AI_TOOLS] : publicTools();
}
