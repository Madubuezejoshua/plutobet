import { getServerSession } from "next-auth";
import { authOptions } from "../auth/auth-options";
import { rbacService, type AdminIdentity } from "./rbac.service";
import { reauthService } from "./reauth.service";
import { requiresReauth, type Permission } from "./permissions";

/**
 * Authorisation guards for the admin area.
 *
 * Two questions, kept separate on purpose:
 *
 *   requireAdminIdentity()      — may this person open the admin area?
 *   requirePermission(p)        — may they do this particular thing?
 *
 * Every admin page and route goes through one of these. Nothing checks
 * `session.user.role === "ADMIN"` directly any more: that was the coarse gate
 * that made a support agent and a super admin the same principal.
 */

export class AdminRequiredError extends Error {
  constructor() {
    super("administrator access is required");
    this.name = "AdminRequiredError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(readonly permission: Permission) {
    // Names the permission: an operator who hits this needs to be able to
    // tell their administrator what to grant. It reveals nothing an
    // authenticated admin could not already infer from the navigation.
    super(`this action requires the ${permission} permission`);
    this.name = "PermissionDeniedError";
  }
}

export class ReauthRequiredError extends Error {
  constructor(readonly permission: Permission) {
    super("re-authentication is required for this action");
    this.name = "ReauthRequiredError";
  }
}

/**
 * Resolves the current admin, or throws.
 *
 * Note this calls the database on every admin request rather than trusting
 * the session token. Role grants must take effect immediately: an operator
 * whose authority is revoked mid-incident should lose it on their next click,
 * not when their eight-hour token expires.
 */
export async function requireAdminIdentity(): Promise<AdminIdentity> {
  const session = await getServerSession(authOptions);
  if (!session?.user) throw new AdminRequiredError();

  const identity = await rbacService.identify(session.user.id);
  if (!identity) throw new AdminRequiredError();

  return identity;
}

/** As above, and additionally requires one specific permission. */
export async function requirePermission(permission: Permission): Promise<AdminIdentity> {
  const identity = await requireAdminIdentity();
  if (!identity.permissions.has(permission)) throw new PermissionDeniedError(permission);
  return identity;
}

/**
 * Permission plus step-up, for the actions where an unlocked laptop must not
 * be enough — moving money, handing out authority, closing an account.
 *
 * The step-up proof is read from the SERVER's record of it, never from the
 * request. An earlier draft of this took a `reauthenticatedAt` timestamp from
 * the caller, which is worthless: the caller picks that value, so anyone able
 * to reach the endpoint could satisfy it with `new Date()`. Worse than
 * useless, in fact — the audit row would then record a re-authentication that
 * never happened.
 *
 * Returns the identity along with the session id, so the caller can consume
 * the window after acting.
 */
export async function requireSensitivePermission(
  permission: Permission,
): Promise<AdminIdentity & { sessionId: string | null }> {
  const session = await getServerSession(authOptions);
  if (!session?.user) throw new AdminRequiredError();

  const identity = await requirePermission(permission);
  const sessionId = session.user.sessionId ?? null;

  if (requiresReauth(permission)) {
    const recent = await reauthService.isRecent(identity.userId, sessionId);
    if (!recent) throw new ReauthRequiredError(permission);
  }

  return { ...identity, sessionId };
}

/** Non-throwing variant, for deciding what to render rather than what to allow. */
export async function currentAdmin(): Promise<AdminIdentity | null> {
  try {
    return await requireAdminIdentity();
  } catch {
    return null;
  }
}
