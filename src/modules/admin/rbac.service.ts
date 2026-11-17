import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import {
  isAdminRole,
  permissionsForRoles,
  type AdminRole,
  type Permission,
} from "./permissions";

/**
 * Granting, revoking and evaluating admin authority.
 *
 * THE RULES THAT MATTER, all of which exist because this module is the one an
 * attacker who has already got in would go for:
 *
 *  - Only SUPER_ADMIN may change roles. Everything else is a read.
 *  - Nobody may grant a role to themselves. A compromised admin session
 *    should not be able to widen its own reach in one request.
 *  - The last SUPER_ADMIN cannot be revoked. Locking every operator out of
 *    the role system is unrecoverable without direct database access.
 *  - Every change carries a mandatory reason and is written to the audit log
 *    in the same transaction as the change itself.
 */

export class RbacError extends Error {
  constructor(
    readonly code:
      | "NOT_PERMITTED"
      | "SELF_GRANT"
      | "LAST_SUPER_ADMIN"
      | "ALREADY_GRANTED"
      | "NOT_GRANTED"
      | "NOT_AN_ADMIN"
      | "UNKNOWN_USER",
    message: string,
  ) {
    super(message);
    this.name = "RbacError";
  }
}

export interface AdminIdentity {
  userId: string;
  email: string;
  roles: AdminRole[];
  permissions: Set<Permission>;
}

export interface RoleGrantRecord {
  id: string;
  userId: string;
  email: string;
  role: AdminRole;
  grantedBy: string;
  grantedByEmail: string | null;
  grantedAt: Date;
  grantedReason: string;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export class RbacService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /** Live roles held by one person. Empty for a non-admin. */
  async rolesOf(userId: string): Promise<AdminRole[]> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => this.rolesInTx(tx, userId));
  }

  /**
   * Everything an authorisation decision needs, in one read.
   *
   * Returns null when the account is not an administrator at all — the coarse
   * `users.role` gate and the fine-grained grants are both required, and this
   * is where the two are combined.
   */
  async identify(userId: string): Promise<AdminIdentity | null> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [account] = await tx.execute<{ email: string; role: string; status: string }>(sql`
        SELECT email, role::text AS role, status::text AS status
        FROM users WHERE id = ${userId}::uuid
      `);
      if (!account) return null;
      // A suspended administrator is not an administrator.
      if (account.role !== "ADMIN" || account.status !== "ACTIVE") return null;

      const roles = await this.rolesInTx(tx, userId);
      return {
        userId,
        email: account.email,
        roles,
        permissions: permissionsForRoles(roles),
      };
    });
  }

  async hasPermission(userId: string, permission: Permission): Promise<boolean> {
    const identity = await this.identify(userId);
    return identity?.permissions.has(permission) ?? false;
  }

  /**
   * Grants a role.
   *
   * The actor must hold SUPER_ADMIN, and must not be the subject. Self-granting
   * is refused even for a super admin who already holds everything, because the
   * rule's value is that it holds unconditionally — an exception for "they
   * could have done it anyway" is exactly the exception an attacker uses.
   */
  async grant(params: {
    actorUserId: string;
    targetUserId: string;
    role: AdminRole;
    reason: string;
    ip: string;
  }): Promise<{ grantId: string }> {
    const reason = params.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new RangeError("a reason of 3-500 characters is required");
    }
    if (!isAdminRole(params.role)) throw new RangeError("unknown admin role");

    if (params.actorUserId === params.targetUserId) {
      throw new RbacError("SELF_GRANT", "you cannot grant a role to yourself");
    }

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      await this.assertActorIsSuperAdmin(tx, params.actorUserId);

      const [target] = await tx.execute<{ id: string; role: string }>(sql`
        SELECT id, role::text AS role FROM users WHERE id = ${params.targetUserId}::uuid
      `);
      if (!target) throw new RbacError("UNKNOWN_USER", "no such account");
      if (target.role !== "ADMIN") {
        // Deliberately refused rather than silently promoting them: turning a
        // customer into an administrator is a separate, more visible decision
        // than deciding which admin powers an administrator holds.
        throw new RbacError(
          "NOT_AN_ADMIN",
          "that account is not an administrator; promote it first",
        );
      }

      const existing = await tx.execute<{ id: string }>(sql`
        SELECT id FROM admin_role_grants
        WHERE user_id = ${params.targetUserId}::uuid
          AND role = ${params.role}::admin_role
          AND revoked_at IS NULL
      `);
      if (existing.length > 0) {
        throw new RbacError("ALREADY_GRANTED", "that account already holds this role");
      }

      const [grant] = await tx.execute<{ id: string }>(sql`
        INSERT INTO admin_role_grants (user_id, role, granted_by, granted_reason)
        VALUES (
          ${params.targetUserId}::uuid,
          ${params.role}::admin_role,
          ${params.actorUserId}::uuid,
          ${reason}
        )
        RETURNING id
      `);
      if (!grant) throw new Error("grant insert returned no row");

      // Audited in the SAME transaction as the change. An audit row written
      // afterwards can be lost by a crash in between, leaving a privilege
      // change nobody recorded.
      await this.audit(tx, {
        actorId: params.actorUserId,
        action: "ADMIN_ROLE_GRANTED",
        entityId: grant.id,
        reason,
        ip: params.ip,
        after: { userId: params.targetUserId, role: params.role },
      });

      return { grantId: grant.id };
    });
  }

  /**
   * Revokes a role.
   *
   * Refuses to remove the last live SUPER_ADMIN. Without that check a single
   * mistaken revocation leaves nobody able to grant roles, and the only repair
   * is a manual UPDATE against production — precisely the operation this whole
   * table exists to make unnecessary.
   */
  async revoke(params: {
    actorUserId: string;
    targetUserId: string;
    role: AdminRole;
    reason: string;
    ip: string;
  }): Promise<void> {
    const reason = params.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new RangeError("a reason of 3-500 characters is required");
    }

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await this.assertActorIsSuperAdmin(tx, params.actorUserId);

      if (params.role === "SUPER_ADMIN") {
        /*
         * Counted with FOR UPDATE so two concurrent revocations cannot each
         * observe two super admins and both proceed, leaving zero. This is a
         * genuine race, not a theoretical one: "remove the departing admin"
         * tends to happen in bulk.
         */
        const holders = await tx.execute<{ user_id: string }>(sql`
          SELECT user_id FROM admin_role_grants
          WHERE role = 'SUPER_ADMIN' AND revoked_at IS NULL
          FOR UPDATE
        `);
        if (holders.length <= 1) {
          throw new RbacError(
            "LAST_SUPER_ADMIN",
            "this is the only super admin; grant the role to someone else first",
          );
        }
      }

      const revoked = await tx.execute<{ id: string }>(sql`
        UPDATE admin_role_grants
        SET revoked_at = now(),
            revoked_by = ${params.actorUserId}::uuid,
            revoked_reason = ${reason}
        WHERE user_id = ${params.targetUserId}::uuid
          AND role = ${params.role}::admin_role
          AND revoked_at IS NULL
        RETURNING id
      `);
      if (revoked.length === 0) {
        throw new RbacError("NOT_GRANTED", "that account does not hold this role");
      }

      await this.audit(tx, {
        actorId: params.actorUserId,
        action: "ADMIN_ROLE_REVOKED",
        entityId: revoked[0]!.id,
        reason,
        ip: params.ip,
        before: { userId: params.targetUserId, role: params.role },
      });
    });
  }

  /** Every grant ever issued, newest first. The authority history. */
  async listGrants(opts?: { includeRevoked?: boolean }): Promise<RoleGrantRecord[]> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        user_id: string;
        email: string;
        role: AdminRole;
        granted_by: string;
        granted_by_email: string | null;
        granted_at: Date;
        granted_reason: string;
        revoked_at: Date | null;
        revoked_reason: string | null;
      }>(sql`
        SELECT g.id, g.user_id, u.email, g.role::text AS role,
               g.granted_by, granter.email AS granted_by_email,
               g.granted_at, g.granted_reason, g.revoked_at, g.revoked_reason
        FROM admin_role_grants g
        JOIN users u ON u.id = g.user_id
        LEFT JOIN users granter ON granter.id = g.granted_by
        WHERE ${opts?.includeRevoked ? sql`TRUE` : sql`g.revoked_at IS NULL`}
        ORDER BY (g.revoked_at IS NULL) DESC, g.granted_at DESC
        LIMIT 200
      `);

      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        email: row.email,
        role: row.role,
        grantedBy: row.granted_by,
        grantedByEmail: row.granted_by_email,
        grantedAt: new Date(row.granted_at),
        grantedReason: row.granted_reason,
        revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
        revokedReason: row.revoked_reason,
      }));
    });
  }

  /** Accounts flagged as administrators, with the roles they currently hold. */
  async listAdministrators(): Promise<
    { userId: string; email: string; status: string; roles: AdminRole[] }[]
  > {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        email: string;
        status: string;
        roles: AdminRole[] | null;
      }>(sql`
        SELECT u.id, u.email, u.status::text AS status,
               array_remove(array_agg(g.role::text ORDER BY g.role::text), NULL) AS roles
        FROM users u
        LEFT JOIN admin_role_grants g
          ON g.user_id = u.id AND g.revoked_at IS NULL
        WHERE u.role = 'ADMIN'
        GROUP BY u.id, u.email, u.status
        ORDER BY u.email
      `);

      return rows.map((row) => ({
        userId: row.id,
        email: row.email,
        status: row.status,
        roles: (row.roles ?? []).filter(isAdminRole),
      }));
    });
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async rolesInTx(tx: WalletTransaction, userId: string): Promise<AdminRole[]> {
    const rows = await tx.execute<{ role: string }>(sql`
      SELECT role::text AS role FROM admin_role_grants
      WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
    `);
    return rows.map((row) => row.role).filter(isAdminRole);
  }

  private async assertActorIsSuperAdmin(
    tx: WalletTransaction,
    actorUserId: string,
  ): Promise<void> {
    const [actor] = await tx.execute<{ role: string; status: string }>(sql`
      SELECT role::text AS role, status::text AS status
      FROM users WHERE id = ${actorUserId}::uuid
    `);
    if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE") {
      throw new RbacError("NOT_PERMITTED", "administrator access is required");
    }

    const roles = await this.rolesInTx(tx, actorUserId);
    if (!roles.includes("SUPER_ADMIN")) {
      throw new RbacError("NOT_PERMITTED", "only a super admin may change roles");
    }
  }

  private async audit(
    tx: WalletTransaction,
    event: {
      actorId: string;
      action: string;
      entityId: string;
      reason: string;
      ip: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id, reason, before, after, ip)
      VALUES (
        'ADMIN', ${event.actorId}::uuid, ${event.action}, 'admin_role_grant',
        ${event.entityId}, ${event.reason},
        ${event.before ? JSON.stringify(event.before) : null}::jsonb,
        ${event.after ? JSON.stringify(event.after) : null}::jsonb,
        ${event.ip}::inet
      )
    `);
  }
}

export const rbacService = new RbacService();
