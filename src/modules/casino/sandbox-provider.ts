import { createHmac, timingSafeEqual } from "node:crypto";
import type { CasinoGameSummary, CasinoProvider, LaunchParams } from "./provider";
import { CasinoSignatureError } from "./provider";

/**
 * DEVELOPMENT AGGREGATOR - NO REAL GAMES, NO REAL MONEY.
 *
 * Exists so the lobby, session handling and callback plumbing can be exercised
 * end to end without an aggregator contract, which is a commercial
 * negotiation rather than a technical one.
 *
 * It is loud about being fake:
 *   - `key` is "sandbox", which is written to every game and round row.
 *   - Game names say so.
 *   - `launchUrl` returns an internal page that explains it, NOT a game.
 *
 * Unlike the payment sandbox, this one DOES verify callback signatures. It has
 * a secret available (AUTH_SECRET), and a callback path that skips verification
 * in development is a callback path nobody has ever tested the failure of.
 */
export class SandboxCasinoProvider implements CasinoProvider {
  readonly key = "sandbox";
  readonly name = "Sandbox (development only)";

  async listGames(): Promise<CasinoGameSummary[]> {
    return [
      { providerGameId: "sandbox-slots-1", name: "Sandbox Slots (demo)", category: "SLOTS", rtpBasisPoints: 9600 },
      { providerGameId: "sandbox-crash-1", name: "Sandbox Crash (demo)", category: "CRASH", rtpBasisPoints: 9700 },
      { providerGameId: "sandbox-roulette", name: "Sandbox Roulette (demo)", category: "TABLE", rtpBasisPoints: 9730 },
      { providerGameId: "sandbox-blackjack", name: "Sandbox Blackjack (demo)", category: "TABLE", rtpBasisPoints: 9950 },
      { providerGameId: "sandbox-live-1", name: "Sandbox Live Table (demo)", category: "LIVE_CASINO" },
      { providerGameId: "sandbox-instant", name: "Sandbox Instant (demo)", category: "INSTANT", rtpBasisPoints: 9500 },
    ];
  }

  async launchUrl(params: LaunchParams): Promise<string> {
    // Deliberately an internal explainer, not a game. Returning a plausible
    // third-party URL would make a fake integration look real.
    return `/casino/sandbox?token=${encodeURIComponent(params.token)}&game=${encodeURIComponent(params.providerGameId)}`;
  }

  verifyCallback(rawBody: string, signature: string | null): void {
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new CasinoSignatureError();
    if (!signature) throw new CasinoSignatureError();

    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const provided = Buffer.from(signature, "utf8");
    const computed = Buffer.from(expected, "utf8");

    if (provided.length !== computed.length) throw new CasinoSignatureError();
    // Constant time: a fast comparison leaks how much of a forged signature
    // was correct, which is enough to forge one byte at a time.
    if (!timingSafeEqual(provided, computed)) throw new CasinoSignatureError();
  }
}
