import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeWalletTestContexts,
  createWalletTestContext,
  type WalletTestContext,
} from "@/modules/wallet/__tests__/helpers";
import { permissionsForRoles } from "../permissions";

/**
 * A3 — QA funding is unreachable from the product.
 * A4 — SUPPORT_AGENT cannot do what only higher-trust roles may.
 *
 * A4 deliberately proves the POSITIVE case as well. A route that rejected
 * everybody would satisfy every negative assertion here while being completely
 * broken, so "support is refused" only means something alongside "an
 * authorised role gets further".
 */

const ctx: WalletTestContext = createWalletTestContext();

afterAll(async () => {
  await closeWalletTestContexts([ctx]);
});

let currentUserId: string | null = null;

/*
 * next-auth is mocked as well as our own session module.
 *
 * `requireSensitivePermission` calls `getServerSession` DIRECTLY rather than
 * going through requireActiveSession, and getServerSession reads `headers()`,
 * which only exists inside a Next request scope. Invoking a route handler
 * from a test has no such scope, so without this the route threw
 * "`headers` was called outside a request scope" and answered 500 — which
 * would have let every authorisation assertion pass for the wrong reason.
 *
 * Only the framework plumbing is replaced. The permission lookup, the grants
 * table and the step-up check are all real.
 */
vi.mock("next-auth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("next-auth");
  return {
    ...actual,
    getServerSession: async () =>
      currentUserId ? { user: { id: currentUserId, sessionId: "test-session" } } : null,
  };
});

vi.mock("@/modules/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/modules/auth/session")>(
    "@/modules/auth/session",
  );
  return {
    ...actual,
    requireActiveSession: async () => {
      if (!currentUserId) throw new actual.ActiveSessionRequiredError();
      return { user: { id: currentUserId } };
    },
  };
});

async function makeUser(role: "ADMIN" | "USER"): Promise<string> {
  const [row] = await ctx.database.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, role, status, kyc_level)
    VALUES (${`rbac-${randomUUID()}@plutobet.test`}, ${"$argon2id$stub"},
            ${role}::user_role, 'ACTIVE', 0)
    RETURNING id::text
  `);
  return row!.id;
}

/**
 * Makes `userId` a super admin, deterministically.
 *
 * THIS USED TO CALL `bootstrapSuperAdmin`, AND THAT MADE THE SUITE FLAKY.
 *
 * The bootstrap is a first-administrator convenience: it returns
 * `{ granted: false, skipped: "SUPER_ADMIN_ALREADY_EXISTS" }` the moment any
 * super admin exists, which is correct behaviour and exactly wrong as test
 * setup. Every file here shares one database, so whether this call did anything
 * depended on which spec reached it first. The return value was ignored, so
 * when it did nothing the "super admin" was a plain administrator with no
 * permissions, and the test failed with a 403 that looks like a broken
 * permission check rather than broken setup.
 *
 * It failed roughly one run in ten. A flaky test on an authorisation control is
 * worse than a failing one: it trains people to re-run, and eventually somebody
 * makes it stable by weakening the assertion.
 *
 * Granting directly is what the rest of this file already does for fixtures,
 * and `bootstrap.acceptance.spec.ts` covers the bootstrap itself.
 */
async function makeSuperAdmin(userId: string): Promise<void> {
  await grantRole(userId, "SUPER_ADMIN", userId);
}

async function grantRole(userId: string, role: string, byUserId: string): Promise<void> {
  await ctx.database.execute(sql`
    INSERT INTO admin_role_grants (user_id, role, granted_by, granted_reason)
    VALUES (${userId}::uuid, ${role}::admin_role, ${byUserId}::uuid, 'granted for an RBAC test')
  `);
}

/**
 * A well-formed request body.
 *
 * The route parses the body BEFORE authorising, so an incomplete payload
 * returns 422 whoever sends it — and a test using one would "pass" against an
 * endpoint with no authorisation at all.
 */
function rolesRequest(targetUserId: string, role: string): Request {
  return new Request("http://localhost/api/admin/roles", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "102.89.0.1" },
    body: JSON.stringify({
      action: "GRANT",
      targetUserId,
      role,
      reason: "an RBAC acceptance test",
    }),
  });
}

async function postRoles(userId: string | null, targetUserId: string, role: string) {
  currentUserId = userId;
  const { POST } = await import("@/app/api/admin/roles/route");
  const response = await POST(rolesRequest(targetUserId, role) as never);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("A3 — QA funding is unreachable from the product", () => {
  const appFiles = walk(join(process.cwd(), "src", "app"));
  const srcFiles = walk(join(process.cwd(), "src"));

  it("nothing in src/ imports the QA credit script", () => {
    // The strongest guarantee is architectural. If no shipped module imports
    // it, no request can reach it however the routes are authenticated.
    const offenders = srcFiles
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) =>
        /from\s+["'].*qa-credit["']|require\(["'].*qa-credit["']\)/.test(readFileSync(file, "utf8")),
      );
    expect(offenders).toEqual([]);
  });

  it("no shipped module references the QA environment flag", () => {
    // ALLOW_QA_CREDIT appearing in application code would mean money creation
    // could be switched on with an environment variable.
    const offenders = srcFiles
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes("__tests__"))
      .filter((file) => readFileSync(file, "utf8").includes("ALLOW_QA_CREDIT"));
    expect(offenders).toEqual([]);
  });

  it("the QA script lives outside the bundled application tree", () => {
    expect(appFiles.some((file) => file.includes("qa-credit"))).toBe(false);
  });

  it("no non-admin route posts an ADJUSTMENT", () => {
    const offenders = appFiles
      .filter((file) => file.endsWith("route.ts") && !file.includes("admin"))
      .filter((file) => /type:\s*["']ADJUSTMENT["']/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the QA script still carries every guard", () => {
    const body = readFileSync(join(process.cwd(), "scripts", "qa-credit.ts"), "utf8");
    expect(body).toContain('process.env.NODE_ENV === "production"');
    expect(body).toContain('process.env.ALLOW_QA_CREDIT !== "true"');
    // Whole kobo only: a float here is the one place money could lose precision.
    expect(body).toMatch(/\/\^\\d\+\$\//);
    // Through the ledger, never a balance UPDATE.
    expect(body).toContain("walletService.withMoneyTransaction");
    expect(body).not.toMatch(/UPDATE\s+wallets\s+SET/i);
    expect(body).toContain("appendAuditLog");
  });
});

describe("A4 — SUPPORT_AGENT versus higher-trust roles", () => {
  it("SUPPORT_AGENT can read, but cannot move money or grant authority", () => {
    const support = permissionsForRoles(["SUPPORT_AGENT"]);

    // The positive half: it is a real role that can do its job.
    expect(support.size).toBeGreaterThan(0);
    expect(support.has("users.read")).toBe(true);

    // Itemised, not asserted in bulk — a bulk check passes just as well when
    // the permission set is empty.
    expect(support.has("wallet.adjust")).toBe(false);
    expect(support.has("bets.settle")).toBe(false);
    expect(support.has("admin.roles.manage")).toBe(false);
    expect(support.has("withdrawals.review")).toBe(false);
    expect(support.has("users.suspend")).toBe(false);
  });

  it("SUPER_ADMIN holds exactly the permissions SUPPORT_AGENT lacks", () => {
    const superAdmin = permissionsForRoles(["SUPER_ADMIN"]);
    for (const permission of [
      "wallet.adjust",
      "bets.settle",
      "admin.roles.manage",
      "withdrawals.review",
      "users.suspend",
    ] as const) {
      expect(superAdmin.has(permission), permission).toBe(true);
    }
  });

  it("refuses a SUPPORT_AGENT at the roles endpoint, and lets a SUPER_ADMIN further", async () => {
    const superAdminId = await makeUser("ADMIN");
    await makeSuperAdmin(superAdminId);
    const supportId = await makeUser("ADMIN");
    await grantRole(supportId, "SUPPORT_AGENT", superAdminId);
    const targetId = await makeUser("ADMIN");

    const refused = await postRoles(supportId, targetId, "FINANCE_ADMIN");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("FORBIDDEN");

    /*
     * The super admin must get PAST the permission gate. It then meets the
     * step-up re-authentication requirement and is refused with
     * REAUTH_REQUIRED (401), which is correct: one password entry authorises
     * one change. What matters here is that it is no longer a 403 — the
     * permission check distinguishes the two roles rather than rejecting
     * everyone.
     */
    const allowed = await postRoles(superAdminId, targetId, "FINANCE_ADMIN");
    expect(allowed.status).not.toBe(403);
    expect(allowed.body.error).not.toBe("FORBIDDEN");
  });

  it("refuses an ordinary customer", async () => {
    const customerId = await makeUser("USER");
    const targetId = await makeUser("ADMIN");
    const response = await postRoles(customerId, targetId, "SUPPORT_AGENT");
    expect(response.status).toBe(403);
  });

  it("refuses an unauthenticated request", async () => {
    const targetId = await makeUser("ADMIN");
    const response = await postRoles(null, targetId, "SUPPORT_AGENT");

    /*
     * 403, not 401, and deliberately so. The admin guard raises
     * AdminRequiredError for "no session" and PermissionDeniedError for "wrong
     * role", and both map to 403 — so an anonymous prober cannot tell an admin
     * endpoint that exists-but-is-forbidden from one they simply are not
     * signed in for. What matters is that it is refused and nothing changed.
     */
    expect(response.status).toBe(403);

    const [row] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM admin_role_grants WHERE user_id = ${targetId}::uuid
    `);
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it("grants NOTHING when a SUPPORT_AGENT attempts an escalation", async () => {
    const superAdminId = await makeUser("ADMIN");
    await makeSuperAdmin(superAdminId);
    const supportId = await makeUser("ADMIN");
    await grantRole(supportId, "SUPPORT_AGENT", superAdminId);
    const targetId = await makeUser("ADMIN");

    const attempt = await postRoles(supportId, targetId, "SUPER_ADMIN");

    // Assert the REFUSAL, not merely the absence of an effect: a 500 would
    // also leave no grant behind, and would pass a weaker assertion while
    // telling us nothing about authorisation.
    expect(attempt.status).toBe(403);

    // And the refusal must be real, not merely reported.
    const [row] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM admin_role_grants
      WHERE user_id = ${targetId}::uuid AND revoked_at IS NULL
    `);
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it("a refusal does not leak what it refused", async () => {
    const superAdminId = await makeUser("ADMIN");
    await makeSuperAdmin(superAdminId);
    const supportId = await makeUser("ADMIN");
    await grantRole(supportId, "SUPPORT_AGENT", superAdminId);
    const targetId = await makeUser("ADMIN");

    const refused = await postRoles(supportId, targetId, "SUPER_ADMIN");
    expect(refused.status).toBe(403);
    const serialised = JSON.stringify(refused.body);
    // An error body is a poor place to restate account state, and a 403 that
    // echoes the grant table would be an information leak wearing a refusal.
    expect(serialised).not.toMatch(/granted_by|grant_id|password|secret/i);
  });
});
