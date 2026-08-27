import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Device sessions, and how a stateless token is made revocable.
 *
 * THE PROBLEM
 * Auth.js is configured with the JWT strategy. A JWT is a signed claim the
 * server does not store, which is why it scales — and also why "sign out my
 * other device" is normally a lie: there is nothing to delete, and the token
 * stays valid until it expires.
 *
 * THE APPROACH
 * Each token carries a `sid` claim identifying a row in `user_sessions`. The
 * `jwt` callback checks that row on every request it already makes a database
 * round-trip for (it re-reads role and status anyway, so this costs nothing
 * extra). A revoked or missing row invalidates the token immediately.
 *
 * WHAT IS NOT STORED
 * No token, and no digest of one. The row holds an id, a coarse device
 * description, and timestamps. A dump of this table lets nobody sign in as
 * anybody.
 *
 * COST
 * `last_seen_at` is only written when it is already stale by more than the
 * threshold below. Without that, every authenticated request would issue a
 * write, and a busy Saturday would spend more database time tracking sessions
 * than taking bets.
 */

const LAST_SEEN_REFRESH_MS = 5 * 60_000;

export interface DeviceSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  /** True for the session making the request. */
  current: boolean;
}

export class SessionService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /** Records a new sign-in and returns the id to embed in the token. */
  async start(params: {
    userId: string;
    userAgent?: string | null;
    ip?: string | null;
  }): Promise<string> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO user_sessions (user_id, user_agent, ip)
        VALUES (
          ${params.userId}::uuid,
          ${truncateUserAgent(params.userAgent)},
          ${params.ip ?? null}::inet
        )
        RETURNING id
      `);
      if (!row) throw new Error("session insert returned no row");
      return row.id;
    });
  }

  /**
   * Confirms a session is still live, refreshing `last_seen_at` if it is stale.
   *
   * Returns false for a revoked, unknown, or wrong-owner session — the last of
   * those meaning a token whose `sid` belongs to somebody else, which is
   * either a bug or an attack and is treated identically.
   */
  async touch(sessionId: string, userId: string): Promise<boolean> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ id: string; last_seen_at: Date }>(sql`
        SELECT id, last_seen_at FROM user_sessions
        WHERE id = ${sessionId}::uuid
          AND user_id = ${userId}::uuid
          AND revoked_at IS NULL
      `);
      if (!row) return false;

      const staleBy = Date.now() - new Date(row.last_seen_at).getTime();
      if (staleBy > LAST_SEEN_REFRESH_MS) {
        await tx.execute(sql`
          UPDATE user_sessions SET last_seen_at = now() WHERE id = ${sessionId}::uuid
        `);
      }
      return true;
    });
  }

  async list(userId: string, currentSessionId?: string): Promise<DeviceSession[]> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        user_agent: string | null;
        ip: string | null;
        created_at: Date;
        last_seen_at: Date;
        revoked_at: Date | null;
        revoked_reason: string | null;
      }>(sql`
        SELECT id, user_agent, ip::text AS ip, created_at, last_seen_at,
               revoked_at, revoked_reason
        FROM user_sessions
        WHERE user_id = ${userId}::uuid
        ORDER BY (revoked_at IS NULL) DESC, last_seen_at DESC
        LIMIT 50
      `);

      return rows.map((row) => ({
        id: row.id,
        userAgent: row.user_agent,
        ip: row.ip,
        createdAt: new Date(row.created_at),
        lastSeenAt: new Date(row.last_seen_at),
        revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
        revokedReason: row.revoked_reason,
        current: row.id === currentSessionId,
      }));
    });
  }

  /**
   * Revokes one session.
   *
   * Scoped to the owner in the WHERE clause rather than checked first, so
   * there is no window between the check and the write, and so a request for
   * somebody else's session id simply affects nothing.
   */
  async revoke(params: {
    userId: string;
    sessionId: string;
    reason?: string;
  }): Promise<boolean> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE user_sessions
        SET revoked_at = now(), revoked_reason = ${params.reason ?? "signed out by user"}
        WHERE id = ${params.sessionId}::uuid
          AND user_id = ${params.userId}::uuid
          AND revoked_at IS NULL
        RETURNING id
      `);
      return rows.length > 0;
    });
  }

  /** Revokes everything except, optionally, the caller's own session. */
  async revokeAll(params: {
    userId: string;
    exceptSessionId?: string;
    reason?: string;
  }): Promise<number> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE user_sessions
        SET revoked_at = now(), revoked_reason = ${params.reason ?? "signed out everywhere"}
        WHERE user_id = ${params.userId}::uuid
          AND revoked_at IS NULL
          AND (${params.exceptSessionId ?? null}::uuid IS NULL
               OR id <> ${params.exceptSessionId ?? null}::uuid)
        RETURNING id
      `);
      return rows.length;
    });
  }
}

/**
 * A readable device label from a User-Agent string.
 *
 * Stored truncated: the full string is long, low-value, and a fingerprinting
 * surface we have no reason to retain in full.
 */
function truncateUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  return userAgent.slice(0, 200);
}

/** Best-effort "Chrome on Android" from a User-Agent, for the settings list. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";

  const browser =
    /Edg\//.test(userAgent) ? "Edge"
    : /OPR\//.test(userAgent) ? "Opera"
    : /Chrome\//.test(userAgent) ? "Chrome"
    : /Firefox\//.test(userAgent) ? "Firefox"
    : /Safari\//.test(userAgent) ? "Safari"
    : "Browser";

  const platform =
    /Android/.test(userAgent) ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent) ? "iOS"
    : /Windows/.test(userAgent) ? "Windows"
    : /Mac OS X/.test(userAgent) ? "macOS"
    : /Linux/.test(userAgent) ? "Linux"
    : "Unknown";

  return `${browser} on ${platform}`;
}

export const sessionService = new SessionService();
