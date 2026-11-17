import { sql } from "drizzle-orm";

/**
 * Granting the very first administrator their powers.
 *
 * WITHOUT THIS THE ADMIN PANEL IS UNREACHABLE ON A FRESH DEPLOYMENT, and the
 * failure is a deadlock rather than an error:
 *
 *   - `RbacService.identify` requires BOTH `users.role = 'ADMIN'` AND a live
 *     row in `admin_role_grants`. Seeding only the users row produces an
 *     account that signs in and is then denied every page.
 *   - `RbacService.grant` refuses unless the actor already holds SUPER_ADMIN,
 *     and refuses self-granting outright.
 *
 * So nothing inside the application can ever issue the first grant. This is
 * the one place allowed to, and it lives in a module rather than inside the
 * seed script so that the same code the script runs is the code under test.
 *
 * `granted_by` is the new administrator itself. The column is NOT NULL because
 * a privilege nobody is accountable for is the one nobody notices, and at
 * bootstrap there genuinely is no other actor — so the reason records exactly
 * that instead of dressing it up as a decision somebody made.
 */

/**
 * The minimum a caller must offer: something that can run a query.
 *
 * Deliberately structural rather than Drizzle's `PgTransaction<…>`, which
 * carries four generic parameters and would drag the whole schema type into a
 * module that only needs to run two statements. The return type is widened
 * because postgres-js resolves a `RowList`, not a plain array, and pinning it
 * would make the database and a transaction mutually incompatible here —
 * both are passed at different call sites.
 *
 * Rows are narrowed at each use instead, which keeps the looseness local.
 */
export interface BootstrapTx {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

export const BOOTSTRAP_REASON =
  "initial bootstrap: first administrator, granted by the seed because no super admin existed to grant it";

export interface BootstrapOutcome {
  granted: boolean;
  /** Why it declined, when it did. Surfaced so a caller can log the reason. */
  skipped?: "SUPER_ADMIN_ALREADY_EXISTS" | "NOT_AN_ADMIN";
}

/**
 * Issues SUPER_ADMIN to `userId`, but only when the system has none.
 *
 * The guard is what keeps this a bootstrap rather than a privilege-escalation
 * path: once any live super admin exists, this becomes a no-op, so it can
 * never re-elevate an account whose role was deliberately revoked, and a
 * second administrator cannot use it to promote themselves.
 *
 * Callers MUST already hold the seed's advisory lock. This function does not
 * take one itself — doing so would make it look safe to call from anywhere,
 * which it is not.
 */
export async function bootstrapSuperAdmin(
  tx: BootstrapTx,
  userId: string,
): Promise<BootstrapOutcome> {
  const superAdminRows = (await tx.execute(sql`
    SELECT user_id FROM admin_role_grants
    WHERE role = 'SUPER_ADMIN' AND revoked_at IS NULL
    LIMIT 1
  `)) as { user_id: string }[];
  if (superAdminRows[0]) return { granted: false, skipped: "SUPER_ADMIN_ALREADY_EXISTS" };

  /*
   * Refuse a target that is not already an administrator.
   *
   * Mirrors RbacService.grant, which refuses for the same reason: turning a
   * customer into an administrator is a separate and more visible decision
   * than deciding which powers an administrator holds. Without this check the
   * bootstrap would be a way to make any account a super admin.
   */
  const targetRows = (await tx.execute(sql`
    SELECT role::text AS role, status::text AS status
    FROM users WHERE id = ${userId}::uuid
  `)) as { role: string; status: string }[];
  const target = targetRows[0];
  if (!target || target.role !== "ADMIN" || target.status !== "ACTIVE") {
    return { granted: false, skipped: "NOT_AN_ADMIN" };
  }

  await tx.execute(sql`
    INSERT INTO admin_role_grants (user_id, role, granted_by, granted_reason)
    VALUES (${userId}::uuid, 'SUPER_ADMIN', ${userId}::uuid, ${BOOTSTRAP_REASON})
  `);

  return { granted: true };
}
