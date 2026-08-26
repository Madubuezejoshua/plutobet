import { getServerSession } from "next-auth";
import { authOptions } from "./auth-options";

/**
 * Admin authorisation and step-up re-authentication (§3.14).
 *
 * Two separate ideas, deliberately not collapsed into one:
 *
 *   requireAdmin        — may this person see the admin area at all?
 *   requireRecentReauth — have they proved it is still them, just now?
 *
 * A long-lived session is fine for reading a dashboard and not fine for
 * moving money. Re-authentication makes a stolen laptop a much smaller
 * problem than a stolen laptop plus a manual credit facility.
 */

export class AdminRequiredError extends Error {
  constructor() {
    super("administrator access is required");
    this.name = "AdminRequiredError";
  }
}

export class ReauthRequiredError extends Error {
  constructor() {
    super("re-authentication is required for this action");
    this.name = "ReauthRequiredError";
  }
}

/** Matches the wallet service's own staleness window. */
export const REAUTH_MAX_AGE_MS = 5 * 60_000;

export async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user || session.user.status !== "ACTIVE" || session.user.role !== "ADMIN") {
    throw new AdminRequiredError();
  }
  return session;
}

/**
 * Validates step-up evidence supplied with a money-moving admin action.
 *
 * The timestamp is checked in BOTH directions. A stale one is the obvious
 * case; a future-dated one is a client trying to buy itself an indefinitely
 * valid credential, and the wallet service rejects it for the same reason.
 */
export function assertRecentReauth(reauthenticatedAt: Date): void {
  const age = Date.now() - reauthenticatedAt.getTime();
  if (age > REAUTH_MAX_AGE_MS) throw new ReauthRequiredError();
  if (age < -30_000) throw new ReauthRequiredError();
}
