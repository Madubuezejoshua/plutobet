import { sql } from "drizzle-orm";
import { redis } from "@/db/redis";
import { verifyPassword } from "../auth/password";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Step-up re-authentication for sensitive admin actions.
 *
 * WHY THE PROOF LIVES ON THE SERVER
 *
 * The obvious design — the client sends `reauthenticatedAt: <timestamp>` with
 * the request and the server checks it is recent — is worthless. The client
 * chooses that value, so anyone who can call the endpoint can call it with
 * `new Date()`. A step-up check that an attacker can satisfy by lying is
 * worse than no step-up check at all, because the audit trail then records a
 * re-authentication that never happened.
 *
 * So the proof is a short-lived key in Redis that only `confirm()` can write,
 * and only after checking a real password. The client sends nothing; the
 * server looks up whether this exact session re-authenticated recently.
 *
 * WHY IT IS KEYED TO THE SESSION AND NOT JUST THE USER
 * Re-authenticating on your laptop must not silently arm a sensitive action on
 * a session someone else has stolen. The device that proved itself is the
 * device that gets the window.
 *
 * WHY REDIS RATHER THAN THE DATABASE
 * It is ephemeral, it expires on its own, and it must not survive a restart —
 * all three are Redis's defaults and none are Postgres's.
 */

const REAUTH_WINDOW_SECONDS = 5 * 60;

export class ReauthError extends Error {
  constructor(readonly code: "WRONG_PASSWORD" | "NO_SESSION" | "UNAVAILABLE", message: string) {
    super(message);
    this.name = "ReauthError";
  }
}

function key(userId: string, sessionId: string): string {
  return `reauth:${userId}:${sessionId}`;
}

export class ReauthService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Verifies the password and opens a five-minute window for this session.
   *
   * Returns when the window closes so the UI can show a countdown rather than
   * failing the operator's action with a surprise.
   */
  async confirm(params: {
    userId: string;
    sessionId: string | null;
    password: string;
  }): Promise<{ expiresAt: Date }> {
    if (!params.sessionId) {
      // A token predating device sessions has nothing to bind the window to.
      // Refusing is right: the alternative is a window any session can use.
      throw new ReauthError("NO_SESSION", "sign out and back in, then try again");
    }

    const passwordHash = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ password_hash: string }>(sql`
        SELECT password_hash FROM users WHERE id = ${params.userId}::uuid
      `);
      return row?.password_hash ?? null;
    });

    if (!passwordHash || !(await verifyPassword(passwordHash, params.password))) {
      throw new ReauthError("WRONG_PASSWORD", "that password is not correct");
    }

    await redis.set(key(params.userId, params.sessionId), "1", "EX", REAUTH_WINDOW_SECONDS);

    return { expiresAt: new Date(Date.now() + REAUTH_WINDOW_SECONDS * 1000) };
  }

  /**
   * Has this session re-authenticated recently?
   *
   * Fails CLOSED. If Redis is unreachable we cannot tell, and the safe answer
   * for a privilege-granting or money-moving action is no. This is the
   * opposite of the choice made for ordinary session validation, where a
   * database blip must not sign the whole userbase out — the asymmetry is
   * deliberate and follows the blast radius.
   */
  async isRecent(userId: string, sessionId: string | null): Promise<boolean> {
    if (!sessionId) return false;
    try {
      return (await redis.exists(key(userId, sessionId))) === 1;
    } catch (error) {
      console.error("[reauth] unable to verify step-up state", error);
      return false;
    }
  }

  /**
   * Closes the window immediately.
   *
   * Called after a sensitive action so one password entry authorises one piece
   * of work, not five minutes of unattended access to everything.
   */
  async consume(userId: string, sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    try {
      await redis.del(key(userId, sessionId));
    } catch (error) {
      // Not fatal: the key expires on its own within the window.
      console.error("[reauth] unable to clear step-up state", error);
    }
  }
}

export const reauthService = new ReauthService();
