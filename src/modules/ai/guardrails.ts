import { navItem, NAV_ITEMS } from "@/lib/navigation";
import { findTool, requiresConfirmation, type ActionLevel, type ToolDefinition } from "./tools";

/**
 * The safety layer.
 *
 * Everything the model asks for passes through here before anything happens.
 * The rules below come from the build spec (12-16), and each is enforced in
 * code rather than requested in a prompt — a prompt is a suggestion an
 * adversarial input can talk around, a function cannot be.
 */

export class GuardrailError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_TOOL"
      | "AUTH_REQUIRED"
      | "CONFIRMATION_REQUIRED"
      | "REAUTH_REQUIRED"
      | "UNKNOWN_DESTINATION"
      | "SELF_EXCLUDED"
      | "ACCOUNT_RESTRICTED",
    message: string,
  ) {
    super(message);
    this.name = "GuardrailError";
  }
}

export interface CallerContext {
  userId: string | null;
  status: string | null;
  /** Set when the customer has explicitly confirmed this specific action. */
  confirmed: boolean;
  /** Set when they have re-authenticated within the step-up window. */
  reauthenticated: boolean;
}

/**
 * Decides whether a tool call may proceed.
 *
 * Ordered deliberately: existence, then identity, then eligibility, then
 * consent. A self-excluded customer must be refused before we discuss whether
 * they confirmed — telling them "confirm to place this bet" and refusing after
 * would be worse than refusing at once.
 */
export function authoriseToolCall(
  toolName: string,
  caller: CallerContext,
): ToolDefinition {
  const tool = findTool(toolName);
  if (!tool) {
    // The model asked for something that does not exist. Not an error to
    // apologise for — it means the model invented a capability, and the honest
    // response is that there is no such tool.
    throw new GuardrailError("UNKNOWN_TOOL", `there is no tool called ${toolName}`);
  }

  if (tool.requiresAuth && !caller.userId) {
    throw new GuardrailError("AUTH_REQUIRED", "you need to sign in for that");
  }

  /*
   * Rule 16: responsible-gambling protections override everything, including
   * anything the AI has been asked to do.
   *
   * A self-excluded customer cannot be helped to bet by any route, and the AI
   * is not an exception to that. The check sits here, above the tool, so no
   * future tool can forget it.
   */
  if (caller.status === "SELF_EXCLUDED" && isGamblingAction(tool.level)) {
    throw new GuardrailError(
      "SELF_EXCLUDED",
      "you have self-excluded, so I cannot help you place a bet. Your funds remain withdrawable.",
    );
  }
  if (
    caller.status &&
    caller.status !== "ACTIVE" &&
    caller.status !== "SELF_EXCLUDED" &&
    isGamblingAction(tool.level)
  ) {
    throw new GuardrailError(
      "ACCOUNT_RESTRICTED",
      `your account is ${caller.status.toLowerCase().replace(/_/g, " ")}, so I cannot do that`,
    );
  }

  // Rules 13 and 14. A financial action needs the customer to have said yes to
  // THIS action, not to have been generally agreeable earlier in the chat.
  //
  // `alwaysConfirm` extends that to tools that change a protection without
  // moving money — see the flag's own note in `tools.ts`.
  if ((requiresConfirmation(tool.level) || tool.alwaysConfirm === true) && !caller.confirmed) {
    throw new GuardrailError(
      "CONFIRMATION_REQUIRED",
      "this needs your explicit confirmation before I can do it",
    );
  }

  if (tool.level === "HIGH_RISK" && !caller.reauthenticated) {
    throw new GuardrailError(
      "REAUTH_REQUIRED",
      "please confirm your password before I continue",
    );
  }

  return tool;
}

function isGamblingAction(level: ActionLevel): boolean {
  return level === "FINANCIAL" || level === "HIGH_RISK";
}

/**
 * Resolves a navigation request against the registry.
 *
 * Rule 17.7: the model must not invent internal URLs. It names a KEY, and this
 * turns the key into a path — so a hallucinated destination produces a refusal
 * rather than a link to a page that does not exist, or worse, one that does but
 * should not have been offered.
 */
export function resolveDestination(key: string): { key: string; href: string; label: string } {
  const item = navItem(key.trim().toLowerCase());
  if (!item) {
    throw new GuardrailError(
      "UNKNOWN_DESTINATION",
      `I cannot navigate to "${key}". Available: ${NAV_ITEMS.map((i) => i.key).join(", ")}`,
    );
  }
  return { key: item.key, href: item.href, label: item.label };
}

/**
 * Language the model must never use about an uncertain outcome.
 *
 * Rule 15: a prediction is never a certainty. This is a last-line check on
 * generated text, not the primary control — the primary control is that
 * predictions come from the analysis service with explicit probabilities
 * attached, so there is nothing to be certain about.
 *
 * It exists because the cost of getting this wrong is not embarrassment: a
 * customer who bets their rent because a model said "guaranteed" has been
 * actively harmed, and a licensed operator that let it happen has a
 * problem beyond the customer.
 */
const CERTAINTY_PATTERNS: readonly RegExp[] = [
  /\bguarantee(d|s)?\b/i,
  /\bcertain(ly)? (to )?win\b/i,
  /\bsure ?(thing|bet|win)\b/i,
  /\bcan(no|')?t lose\b/i,
  /\b100% (sure|certain|win)/i,
  /\bdefinitely (will )?win\b/i,
  /\brisk[- ]free\b/i,
  /\bno[- ]lose\b/i,
];

export interface CertaintyCheck {
  safe: boolean;
  matched: string[];
}

export function checkForCertaintyClaims(text: string): CertaintyCheck {
  const matched: string[] = [];
  for (const pattern of CERTAINTY_PATTERNS) {
    const found = pattern.exec(text);
    if (found) matched.push(found[0]);
  }
  return { safe: matched.length === 0, matched };
}

/**
 * The one-line disclaimer that accompanies any probability.
 *
 * Deliberately fixed text rather than something the model writes. A generated
 * caveat can be omitted, softened, or written in a way that undercuts itself;
 * this cannot.
 */
export const PREDICTION_DISCLAIMER =
  "This is an estimate from historical data, not a prediction of what will happen. " +
  "Every outcome remains uncertain.";

/**
 * Instructions the model is given.
 *
 * Worth being clear about what this is FOR: it shapes tone and steers the model
 * toward the right tool. It is NOT a security control. Every rule that matters
 * is enforced above by code that runs whatever the model was persuaded to say.
 */
export const SYSTEM_INSTRUCTIONS = `You are Pluto, the assistant for PlutoBet, a Nigerian betting platform.

WHAT YOU CAN DO
Answer questions about fixtures, odds, results and the customer's own account
by calling the tools available to you. You have no other access to data.

WHAT YOU MUST NOT DO
- Never state that any outcome is guaranteed, certain, or risk-free. Outcomes
  are uncertain; say so.
- Never invent odds, fixtures, balances or results. If a tool did not return it,
  say you cannot verify it right now.
- Never place a bet, move money, or change a limit without the customer
  explicitly confirming that specific action.
- Never discuss another customer's account. You cannot see one.
- Never encourage a customer to raise or remove a gambling limit, or to reverse
  a self-exclusion. If they ask, tell them where the settings are and leave the
  decision to them.

TONE
Plain Nigerian English. Amounts in naira. Brief. If somebody seems to be
chasing losses, say nothing encouraging and mention the deposit limit tools
once, without lecturing.`;
