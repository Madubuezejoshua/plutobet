import { SYSTEM_INSTRUCTIONS } from "./guardrails";
import { toolsFor, type ToolDefinition } from "./tools";
import { retrieve } from "./retrieval";

/**
 * The language-model contract.
 *
 * Same rule as every other adapter here: nothing outside this module imports a
 * vendor SDK, so swapping models is a new adapter rather than a rewrite.
 *
 * WHAT THE MODEL IS AND IS NOT TRUSTED WITH
 * It chooses which tool to call and writes the prose around the result. It has
 * no data access, no ability to name another customer, and no way to complete a
 * financial action. Those are not instructions it is asked to follow — they are
 * properties of the runtime it is called from.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelResponse {
  /** What to say. May be empty when the model only wants a tool. */
  text: string;
  /** At most one per turn: a chain of calls is a chain of unreviewed actions. */
  toolCall?: ToolCall;
}

export interface AiProvider {
  readonly name: string;
  readonly live: boolean;

  respond(params: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
    systemInstructions: string;
  }): Promise<ModelResponse>;
}

/**
 * DEVELOPMENT ASSISTANT - NOT A LANGUAGE MODEL.
 *
 * Used when no model API key is configured. It is a small keyword router, and
 * it says so: `name` is "rules-based", and the UI shows that to the customer.
 *
 * WHY THIS EXISTS RATHER THAN A DISABLED PAGE
 * Everything around the model — the tool registry, the guardrails, the draft
 * flow, the confirmation UI — is the part that has to be right, and it can be
 * exercised and tested without a model. Wiring a real one later becomes an
 * adapter swap against machinery already proven, rather than the first time any
 * of it has run.
 *
 * It is deliberately incapable of the things a model is dangerous for. It
 * cannot compose a sentence, so it cannot promise a certainty, cannot invent a
 * fixture, and cannot be talked into anything by a prompt injection.
 */
export class RulesBasedProvider implements AiProvider {
  readonly name = "rules-based";
  readonly live = false;

  async respond(params: { messages: ChatMessage[] }): Promise<ModelResponse> {
    const last = params.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const text = last.toLowerCase();

    if (/\b(balance|how much|my money|wallet)\b/.test(text)) {
      return { text: "", toolCall: { name: "getBalance", arguments: {} } };
    }
    if (/\b(my bets|my tickets|open bets)\b/.test(text)) {
      return { text: "", toolCall: { name: "getMyBets", arguments: {} } };
    }
    if (/\b(transaction|statement|history)\b/.test(text)) {
      return { text: "", toolCall: { name: "getMyTransactions", arguments: { limit: 10 } } };
    }
    if (/\b(live|in play|playing now|score)\b/.test(text)) {
      return { text: "", toolCall: { name: "getLiveEvents", arguments: {} } };
    }
    if (/\b(promo|bonus|offer)\b/.test(text)) {
      return { text: "", toolCall: { name: "getPromotions", arguments: {} } };
    }

    /*
     * Retrieval before keyword routing.
     *
     * A question the knowledge base can answer exactly should be answered from
     * it rather than routed to a tool that returns something adjacent -- and
     * the corpus declines rather than returning a near-miss, so this cannot
     * hijack a question it does not really cover.
     */
    const known = retrieve(last);
    if (known) return { text: known.entry.answer };

    const explain = /what (is|does) (an? )?([a-z0-9 .]+?)( mean)?\??$/.exec(text);
    if (explain?.[3]) {
      return { text: "", toolCall: { name: "explainMarket", arguments: { market: explain[3] } } };
    }

    const match = /\b(?:match(?:es)?|fixture|game|playing|show me|find)\b(.*)/.exec(text);
    if (match) {
      const query = (match[1] ?? "")
        .replace(/\b(today|tomorrow|for|the|on|me|any|show|please)\b/g, "")
        .trim();
      return { text: "", toolCall: { name: "findFixtures", arguments: { query } } };
    }

    return {
      text:
        "I am running in rules-based mode, so I understand only a few things: your balance, " +
        "your bets, your transactions, live matches, promotions, finding a fixture, and " +
        "explaining a market. Connect a model API key for full conversation.",
    };
  }
}

/**
 * Chooses the assistant.
 *
 * Unlike the payment provider, the fallback here is safe to run in production:
 * a keyword router cannot invent a fixture, promise a certainty, or be
 * prompt-injected. It is limited, not dangerous, so it degrades rather than
 * refusing to start.
 */
export function createAiProvider(): AiProvider {
  // A real adapter slots in here when a key is configured. Deliberately not
  // stubbed with an SDK that is not installed — a broken import is worse than
  // an honest limitation.
  return new RulesBasedProvider();
}

export function isLiveModel(): boolean {
  return createAiProvider().live;
}

let cached: AiProvider | undefined;
export function aiProvider(): AiProvider {
  cached ??= createAiProvider();
  return cached;
}

export { SYSTEM_INSTRUCTIONS, toolsFor };
