import { describe, expect, it } from "vitest";
import {
  authoriseToolCall,
  checkForCertaintyClaims,
  GuardrailError,
  resolveDestination,
} from "../guardrails";
import { AI_TOOLS, findTool, publicTools, requiresConfirmation } from "../tools";

const anonymous = { userId: null, status: null, confirmed: false, reauthenticated: false };
const player = { userId: "u1", status: "ACTIVE", confirmed: false, reauthenticated: false };

/**
 * These tests are the AI safety controls. Each maps to a numbered rule in the
 * build spec, and each is enforced by code rather than by a prompt — a prompt
 * is a suggestion an adversarial input can talk around.
 */
describe("AI guardrails", () => {
  describe("rule 12: no unrestricted access", () => {
    it("refuses a tool that does not exist", () => {
      // The model invented a capability. There is nothing to apologise for.
      expect(() => authoriseToolCall("runSql", player)).toThrow(GuardrailError);
      expect(() => authoriseToolCall("deleteUser", player)).toThrow(/no tool called/);
    });

    it("exposes no tool that takes another customer's id", () => {
      for (const tool of AI_TOOLS) {
        if (!tool.scopedToUser) continue;
        // A user-scoped tool receives the session's id from the runtime. If it
        // had a userId parameter, the model could name somebody else.
        expect(Object.keys(tool.parameters)).not.toContain("userId");
        expect(Object.keys(tool.parameters)).not.toContain("customerId");
      }
    });

    it("gives an anonymous visitor public reads only", () => {
      for (const tool of publicTools()) {
        expect(tool.level).toBe("READ");
        expect(tool.scopedToUser).toBe(false);
      }
    });

    it("refuses an account tool without a session", () => {
      expect(() => authoriseToolCall("getBalance", anonymous)).toThrow(/sign in/);
      expect(() => authoriseToolCall("getMyBets", anonymous)).toThrow(GuardrailError);
    });
  });

  describe("rules 13 and 14: nothing financial without explicit confirmation", () => {
    it("refuses to prepare a bet unconfirmed", () => {
      expect(() => authoriseToolCall("prepareBet", player)).toThrow(/explicit confirmation/);
    });

    it("allows it once the customer has confirmed", () => {
      const tool = authoriseToolCall("prepareBet", { ...player, confirmed: true });
      expect(tool.name).toBe("prepareBet");
    });

    it("requires re-authentication for a withdrawal, not just confirmation", () => {
      expect(() =>
        authoriseToolCall("prepareWithdrawal", { ...player, confirmed: true }),
      ).toThrow(/password/);

      const tool = authoriseToolCall("prepareWithdrawal", {
        ...player,
        confirmed: true,
        reauthenticated: true,
      });
      expect(tool.name).toBe("prepareWithdrawal");
    });

    it("marks every money-moving tool as needing confirmation", () => {
      for (const tool of AI_TOOLS) {
        const movesMoney = /^(place|prepare|cashout|deposit|withdraw)/i.test(tool.name);
        if (movesMoney) expect(requiresConfirmation(tool.level)).toBe(true);
      }
    });

    it("never lets a read require confirmation, which would train people to click yes", () => {
      for (const tool of AI_TOOLS) {
        if (tool.level === "READ") expect(requiresConfirmation(tool.level)).toBe(false);
      }
    });
  });

  describe("rule 16: responsible gambling overrides the AI", () => {
    /*
     * The check that matters most in this file. A self-excluded customer must
     * not be helped to bet by ANY route, and an assistant that is technically
     * following instructions is exactly the route somebody would try.
     */
    it("refuses to help a self-excluded customer bet, even with confirmation", () => {
      expect(() =>
        authoriseToolCall("prepareBet", {
          userId: "u1",
          status: "SELF_EXCLUDED",
          confirmed: true,
          reauthenticated: true,
        }),
      ).toThrow(/self-excluded/i);
    });

    it("still lets a self-excluded customer see their own balance", () => {
      // Their money remains theirs. Trapping it would punish somebody for
      // using the protection.
      const tool = authoriseToolCall("getBalance", {
        userId: "u1",
        status: "SELF_EXCLUDED",
        confirmed: false,
        reauthenticated: false,
      });
      expect(tool.name).toBe("getBalance");
    });

    it("refuses a suspended account", () => {
      expect(() =>
        authoriseToolCall("prepareBet", {
          userId: "u1",
          status: "SUSPENDED",
          confirmed: true,
          reauthenticated: true,
        }),
      ).toThrow(/suspended/i);
    });
  });

  describe("rule 15: a prediction is never a certainty", () => {
    it.each([
      "Arsenal are guaranteed to win",
      "This is a sure bet",
      "They simply cannot lose",
      "100% certain",
      "Chelsea will definitely win",
      "A risk-free accumulator",
    ])("flags %s", (text) => {
      const result = checkForCertaintyClaims(text);
      expect(result.safe).toBe(false);
      expect(result.matched.length).toBeGreaterThan(0);
    });

    it.each([
      "The model estimates Arsenal at about 56%",
      "Arsenal have won four of their last five",
      "This is a seven-fold; all seven must win",
      "I cannot verify the current price",
    ])("allows %s", (text) => {
      expect(checkForCertaintyClaims(text).safe).toBe(true);
    });
  });

  describe("rule 17.7: the model cannot invent a URL", () => {
    it("resolves a known key to its real path", () => {
      expect(resolveDestination("sports").href).toBe("/sports");
      expect(resolveDestination("WALLET").href).toBe("/wallet");
    });

    it("refuses an invented destination and lists the real ones", () => {
      expect(() => resolveDestination("admin-panel")).toThrow(/cannot navigate/);
      expect(() => resolveDestination("/etc/passwd")).toThrow(GuardrailError);
    });
  });

  describe("registry integrity", () => {
    it("has no duplicate tool names", () => {
      const names = AI_TOOLS.map((tool) => tool.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("can look up every declared tool", () => {
      for (const tool of AI_TOOLS) expect(findTool(tool.name)).toBeDefined();
    });

    it("scopes every authenticated data tool to the caller", () => {
      for (const tool of AI_TOOLS) {
        // A tool that needs a session and reads data must be user-scoped;
        // otherwise it is reading something that is not the caller's.
        if (tool.requiresAuth && tool.level === "READ") {
          expect(tool.scopedToUser, `${tool.name} is not scoped`).toBe(true);
        }
      }
    });
  });
});
