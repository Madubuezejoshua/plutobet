import { describe, expect, it } from "vitest";
import { CANNOT_VERIFY, KNOWLEDGE_BASE, retrieve, vetAnswer } from "../retrieval";

/**
 * Rule 19.1: never invent an answer.
 *
 * The tests that matter here are the NEGATIVE ones. Returning the least-bad
 * match is how a question about withdrawing a bonus gets answered, confidently,
 * with a paragraph about deposits.
 */
describe("retrieval", () => {
  describe("finds the right entry", () => {
    it.each([
      ["can I withdraw my bonus?", "bonus-withdrawal"],
      ["why is my withdrawal pending", "withdrawal-pending"],
      ["how much does a system bet cost", "system-bet-cost"],
      ["how do I set a deposit limit", "deposit-limit"],
      ["how do I self exclude", "self-exclusion"],
      ["what is cash out", "cashout"],
      ["do I need to verify", "kyc-required"],
    ])("%s -> %s", (question, expectedId) => {
      const hit = retrieve(question);
      expect(hit).not.toBeNull();
      expect(hit!.entry.id).toBe(expectedId);
    });
  });

  describe("returns nothing rather than something close", () => {
    it.each([
      "what is the capital of France",
      "who will win the league this season",
      "tell me a joke",
      "what is my neighbour's balance",
      "",
      "the a is of",
    ])("declines: %s", (question) => {
      expect(retrieve(question)).toBeNull();
    });

    /*
     * The specific failure this guards. "Deposit" appears in several entries;
     * a nearest-match search would answer a question about depositing with
     * whichever paragraph shared the most words, and sound sure about it.
     */
    it("does not answer an unrelated deposit question from a bonus entry", () => {
      const hit = retrieve("what deposit methods do you accept");
      if (hit) expect(hit.entry.id).not.toBe("bonus-withdrawal");
    });
  });

  describe("vetting an answer before it is shown", () => {
    it("refuses when nothing was retrieved", () => {
      const result = vetAnswer("Probably around 60%.", false);
      expect(result.refused).toBe(true);
      expect(result.text).toBe(CANNOT_VERIFY);
    });

    it("refuses an answer claiming certainty even with a source", () => {
      const result = vetAnswer("You are guaranteed to win this one.", true);
      expect(result.refused).toBe(true);
      expect(result.text).toMatch(/no outcome is certain/i);
    });

    it("passes a sourced, hedged answer through unchanged", () => {
      const answer = "Bonus credit converts to cash once wagering is met.";
      const result = vetAnswer(answer, true);
      expect(result.refused).toBe(false);
      expect(result.text).toBe(answer);
    });
  });

  describe("corpus integrity", () => {
    it("has no duplicate ids", () => {
      const ids = KNOWLEDGE_BASE.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("names the module each answer describes, so the two can be kept honest", () => {
      for (const entry of KNOWLEDGE_BASE) {
        expect(entry.source).toMatch(/^modules\//);
        expect(entry.questions.length).toBeGreaterThan(0);
        expect(entry.answer.length).toBeGreaterThan(40);
      }
    });

    it("contains no answer that claims certainty", () => {
      for (const entry of KNOWLEDGE_BASE) {
        expect(vetAnswer(entry.answer, true).refused, entry.id).toBe(false);
      }
    });

    it("retrieves every entry from at least one of its own phrasings", () => {
      for (const entry of KNOWLEDGE_BASE) {
        const hit = retrieve(entry.questions[0]!);
        expect(hit?.entry.id, entry.id).toBe(entry.id);
      }
    });
  });
});
