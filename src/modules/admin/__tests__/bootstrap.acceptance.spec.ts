import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeWalletTestContexts,
  createWalletTestContext,
  type WalletTestContext,
} from "@/modules/wallet/__tests__/helpers";
import { BOOTSTRAP_REASON, bootstrapSuperAdmin } from "../bootstrap";

/**
 * Regression tests for the first-administrator bootstrap.
 *
 * The bug: `RbacService.identify` requires BOTH `users.role = 'ADMIN'` AND a
 * live `admin_role_grants` row, while `RbacService.grant` refuses unless the
 * actor already holds SUPER_ADMIN and refuses self-granting. The seed created
 * only the users row, so the first administrator could sign in and was then
 * denied every page — with no path in the application to fix it. A deadlock,
 * not an error, and it made the admin panel permanently unreachable on any
 * fresh deployment.
 *
 * These tests exercise the same module the seed script calls.
 */

const ctx: WalletTestContext = createWalletTestContext();

afterAll(async () => {
  await closeWalletTestContexts([ctx]);
});

/**
 * Isolates each test, because the bootstrap's guard is global by design.
 *
 * Grants are REVOKED rather than deleted. The table is append-only — the
 * schema pairs `revoked_at` with `revoked_by` and a reason precisely so a
 * privilege change leaves a trace — so a DELETE here would be testing against
 * a shape the production database never takes.
 */
beforeEach(async () => {
  await ctx.database.execute(sql`
    UPDATE admin_role_grants
    SET revoked_at = now(), revoked_by = granted_by, revoked_reason = 'test isolation'
    WHERE revoked_at IS NULL
  `);
});

async function makeUser(role: "ADMIN" | "USER", status = "ACTIVE"): Promise<string> {
  const email = `bootstrap-${randomUUID()}@plutobet.test`;
  const [row] = await ctx.database.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, role, status, kyc_level)
    VALUES (${email}, ${"$argon2id$stub"}, ${role}::user_role, ${status}::user_status, 0)
    RETURNING id::text
  `);
  return row!.id;
}

async function liveGrants(userId: string) {
  return ctx.database.execute<{ role: string; granted_by: string; granted_reason: string }>(sql`
    SELECT role::text, granted_by::text, granted_reason
    FROM admin_role_grants
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
  `);
}

describe("first-administrator bootstrap", () => {
  it("grants SUPER_ADMIN when the system has none", async () => {
    const adminId = await makeUser("ADMIN");

    const outcome = await bootstrapSuperAdmin(ctx.database, adminId);

    expect(outcome.granted).toBe(true);
    const grants = await liveGrants(adminId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.role).toBe("SUPER_ADMIN");
  });

  it("records an accountable reason and grantor", async () => {
    const adminId = await makeUser("ADMIN");
    await bootstrapSuperAdmin(ctx.database, adminId);

    const [grant] = await liveGrants(adminId);
    // granted_by is NOT NULL: a privilege nobody is accountable for is the one
    // nobody notices. At bootstrap the only honest answer is the admin itself,
    // and the reason must say so rather than implying somebody decided it.
    expect(grant!.granted_by).toBe(adminId);
    expect(grant!.granted_reason).toBe(BOOTSTRAP_REASON);
    expect(grant!.granted_reason.length).toBeGreaterThanOrEqual(3);
  });

  it("is idempotent — running it repeatedly leaves exactly one grant", async () => {
    const adminId = await makeUser("ADMIN");

    const first = await bootstrapSuperAdmin(ctx.database, adminId);
    const second = await bootstrapSuperAdmin(ctx.database, adminId);
    const third = await bootstrapSuperAdmin(ctx.database, adminId);

    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);
    expect(third.granted).toBe(false);
    expect(await liveGrants(adminId)).toHaveLength(1);
  });

  it("refuses once ANY live super admin exists — a second admin cannot self-promote", async () => {
    const firstAdmin = await makeUser("ADMIN");
    await bootstrapSuperAdmin(ctx.database, firstAdmin);

    const secondAdmin = await makeUser("ADMIN");
    const outcome = await bootstrapSuperAdmin(ctx.database, secondAdmin);

    // The whole value of the guard is that it is unconditional. If a second
    // administrator could bootstrap themselves, this would be an escalation
    // path rather than a bootstrap.
    expect(outcome.granted).toBe(false);
    expect(outcome.skipped).toBe("SUPER_ADMIN_ALREADY_EXISTS");
    expect(await liveGrants(secondAdmin)).toHaveLength(0);
  });

  it("does not re-elevate an account whose grant was deliberately revoked", async () => {
    const adminId = await makeUser("ADMIN");
    await bootstrapSuperAdmin(ctx.database, adminId);

    // Somebody revoked it on purpose, and another super admin remains.
    const other = await makeUser("ADMIN");
    await ctx.database.execute(sql`
      INSERT INTO admin_role_grants (user_id, role, granted_by, granted_reason)
      VALUES (${other}::uuid, 'SUPER_ADMIN', ${other}::uuid, 'second super admin for this test')
    `);
    await ctx.database.execute(sql`
      UPDATE admin_role_grants
      SET revoked_at = now(), revoked_by = ${other}::uuid, revoked_reason = 'revoked on purpose'
      WHERE user_id = ${adminId}::uuid
    `);

    const outcome = await bootstrapSuperAdmin(ctx.database, adminId);

    expect(outcome.granted).toBe(false);
    expect(await liveGrants(adminId)).toHaveLength(0);
  });

  it("refuses to promote an account that is not already an administrator", async () => {
    const customerId = await makeUser("USER");

    const outcome = await bootstrapSuperAdmin(ctx.database, customerId);

    // Turning a customer into an administrator is a separate, more visible
    // decision than deciding which powers an administrator holds — the same
    // rule RbacService.grant enforces.
    expect(outcome.granted).toBe(false);
    expect(outcome.skipped).toBe("NOT_AN_ADMIN");
    expect(await liveGrants(customerId)).toHaveLength(0);
  });

  it("refuses a suspended administrator", async () => {
    const suspendedId = await makeUser("ADMIN", "SUSPENDED");

    const outcome = await bootstrapSuperAdmin(ctx.database, suspendedId);

    expect(outcome.granted).toBe(false);
    expect(await liveGrants(suspendedId)).toHaveLength(0);
  });

  it("grants only once when two bootstraps race inside serialized transactions", async () => {
    // The seed wraps this in `pg_advisory_xact_lock('seed:initial-admin')`.
    // Taking the same lock here proves the pattern holds the invariant: the
    // second transaction observes the first one's grant and declines.
    const adminA = await makeUser("ADMIN");
    const adminB = await makeUser("ADMIN");

    const attempt = (userId: string) =>
      ctx.database.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended('seed:initial-admin', 0))`,
        );
        return bootstrapSuperAdmin(tx, userId);
      });

    const results = await Promise.all([attempt(adminA), attempt(adminB)]);

    expect(results.filter((r) => r.granted)).toHaveLength(1);
    const counted = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM admin_role_grants
      WHERE role = 'SUPER_ADMIN' AND revoked_at IS NULL
    `);
    expect(counted[0]?.n).toBe(1);
  });
});
