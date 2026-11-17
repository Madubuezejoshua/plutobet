import { checkForCertaintyClaims } from "./guardrails";

/**
 * Retrieval, and the rule that makes it worth having.
 *
 * RULE 19.1: Pluto must never invent odds, fixtures, balances, deposits,
 * winnings, withdrawals or results. When it cannot verify something it says so.
 *
 * WHY THIS IS A CURATED CORPUS AND NOT AN EMBEDDING SEARCH
 * The questions a betting customer actually asks — what does a system bet cost,
 * why is my withdrawal pending, how do I set a limit — have exact answers that
 * change when the product changes. A vector search over prose returns the
 * nearest paragraph, which for "can I withdraw my bonus?" is a paragraph about
 * bonuses that may well say the opposite of the truth.
 *
 * These entries are written against the actual behaviour of the code, and each
 * names the module that decides it, so a wrong answer here is findable rather
 * than mysterious. When the corpus has no answer, the caller is told to say so
 * instead of paraphrasing something close.
 */

export interface KnowledgeEntry {
  id: string;
  /** What a customer would type, not what a search engine would index. */
  questions: string[];
  answer: string;
  /** The module whose behaviour this describes. Keeps the two honest. */
  source: string;
}

export const KNOWLEDGE_BASE: readonly KnowledgeEntry[] = [
  {
    id: "bonus-withdrawal",
    questions: [
      "can i withdraw my bonus",
      "why can't i withdraw my bonus",
      "is bonus money real money",
      "bonus balance withdraw",
    ],
    answer:
      "Bonus credit is not withdrawable until its wagering requirement is met. You can stake it, " +
      "and anything it wins is yours, but the bonus itself converts to cash only after you have " +
      "staked it the required number of times. Your cash balance is always withdrawable and is " +
      "kept separate from it.",
    source: "modules/promotions/bonus.service.ts",
  },
  {
    id: "system-bet-cost",
    questions: [
      "how much does a system bet cost",
      "why did my 2/3 cost more",
      "what is a system bet",
      "what does cut 1 mean",
    ],
    answer:
      "A system bet places every combination of your selections, and you pay the stake once per " +
      "combination. A 2/3 from three selections is three separate bets, so a ₦100 2/3 costs ₦300. " +
      "The advantage is that one losing leg does not kill the whole slip.",
    source: "modules/betting/system-bet.ts",
  },
  {
    id: "withdrawal-pending",
    questions: [
      "why is my withdrawal pending",
      "how long does a withdrawal take",
      "where is my money",
      "withdrawal not received",
    ],
    answer:
      "A withdrawal is reviewed before the transfer is sent. The money leaves your balance when " +
      "you request it and is held until the payout is approved and the bank confirms it. If it " +
      "fails, the full amount is returned to your balance automatically.",
    source: "modules/payments/withdrawal.service.ts",
  },
  {
    id: "kyc-required",
    questions: [
      "why can't i withdraw",
      "do i need to verify",
      "what is kyc",
      "verification required",
    ],
    answer:
      "Unverified accounts cannot withdraw at all. Confirming your BVN or NIN raises your daily " +
      "limit to ₦50,000; a reviewed document raises it to ₦500,000. We are not permitted to pay " +
      "out to an account that has not proven who owns it.",
    source: "modules/kyc/kyc.service.ts",
  },
  {
    id: "deposit-limit",
    questions: [
      "how do i set a deposit limit",
      "limit my spending",
      "gambling limit",
      "stop me betting",
    ],
    answer:
      "You can set deposit, loss and stake limits on your responsible gambling page. Lowering a " +
      "limit takes effect immediately. Raising one waits 24 hours, on purpose — so a decision " +
      "made in the moment cannot take effect in that moment.",
    source: "modules/responsible/responsible.service.ts",
  },
  {
    id: "self-exclusion",
    questions: [
      "how do i self exclude",
      "close my account gambling",
      "block myself",
      "stop me from gambling",
    ],
    answer:
      "Self-exclusion is on your responsible gambling page. It cannot be reversed before the " +
      "period ends, and it follows your verified identity — so it still applies if you register " +
      "again with a different email. Your balance remains withdrawable throughout.",
    source: "modules/responsible/responsible.service.ts",
  },
  {
    id: "odds-change",
    questions: [
      "my odds changed",
      "why was my bet rejected",
      "price changed before i placed",
      "odds moved",
    ],
    answer:
      "Prices move. By default we stop and ask you before placing a bet at a different price " +
      "from the one you saw. You can change this on your preferences page to accept better " +
      "prices automatically, or any change.",
    source: "modules/betting/placement.service.ts",
  },
  {
    id: "cashout",
    questions: [
      "what is cash out",
      "can i cash out",
      "take my money early",
      "partial cashout",
    ],
    answer:
      "Cash out lets you take the current value of an open bet before it settles, instead of " +
      "waiting. You can take all of it or part; if you take part, the rest keeps running and " +
      "settles normally on the remaining stake.",
    source: "modules/betting/cashout.service.ts",
  },
  {
    id: "jackpot-prize",
    questions: [
      "how does the jackpot work",
      "jackpot prize",
      "what if nobody wins the jackpot",
    ],
    answer:
      "You predict every fixture on the slate. The prize pool is shared equally between everyone " +
      "with the most correct predictions. If nobody reaches the advertised minimum, no prize is " +
      "paid — the pool is not rolled over unless the competition says so.",
    source: "modules/jackpot/jackpot.service.ts",
  },
];

export interface RetrievalHit {
  entry: KnowledgeEntry;
  score: number;
}

/**
 * Finds an answer, or does not.
 *
 * Token overlap against the phrasings a customer would actually use, with a
 * FLOOR: below it, nothing is returned. Returning the least-bad match is how a
 * question about withdrawing a bonus gets answered with a paragraph about
 * deposits, and confidently.
 */
export function retrieve(question: string, minimumScore = 0.34): RetrievalHit | null {
  const asked = tokenise(question);
  if (asked.size === 0) return null;

  let best: RetrievalHit | null = null;

  for (const entry of KNOWLEDGE_BASE) {
    for (const phrasing of entry.questions) {
      const candidate = tokenise(phrasing);
      const overlap = [...candidate].filter((token) => asked.has(token)).length;
      if (overlap === 0) continue;

      // Scored against the STORED phrasing, so a long rambling question does
      // not dilute a match on the part that mattered.
      const score = overlap / candidate.size;
      if (!best || score > best.score) best = { entry, score };
    }
  }

  return best && best.score >= minimumScore ? best : null;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "do", "does", "did", "i", "my", "me", "you",
  "can", "could", "would", "how", "what", "why", "when", "to", "of", "in", "on",
  "for", "and", "or", "it", "this", "that", "be", "was", "get", "got", "have",
]);

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

/**
 * The refusal.
 *
 * Fixed text, deliberately. "I cannot verify that right now" is the honest
 * answer when nothing was retrieved, and a model asked to phrase it itself will
 * eventually phrase it as a guess.
 */
export const CANNOT_VERIFY =
  "I cannot verify that right now. I would rather say so than guess — try asking " +
  "support, or check the page for that part of your account.";

/**
 * Final check before an answer is shown.
 *
 * Two failure modes, both fatal to trust on a gambling product: claiming
 * certainty about an outcome, and answering from nothing. This catches both and
 * substitutes the honest refusal.
 */
export function vetAnswer(text: string, hadSource: boolean): { text: string; refused: boolean } {
  if (!hadSource) return { text: CANNOT_VERIFY, refused: true };

  const certainty = checkForCertaintyClaims(text);
  if (!certainty.safe) {
    return {
      text: "I cannot put it that way — no outcome is certain. Ask me for the odds instead.",
      refused: true,
    };
  }

  return { text, refused: false };
}
