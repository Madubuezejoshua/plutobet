import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLES,
  PERMISSIONS,
  REAUTH_REQUIRED_PERMISSIONS,
  permissionsForRoles,
  permissionsOfRole,
  requiresReauth,
  roleHasPermission,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type AdminRole,
} from "../permissions";
import { ADMIN_NAV, visibleNav } from "../navigation";

/**
 * The authority model, asserted rather than assumed.
 *
 * These are separation-of-duty rules, not preferences: each one exists because
 * collapsing the two sides of it creates a way for one person to both cause a
 * problem and hide it.
 */
describe("admin permissions", () => {
  describe("separation of duties", () => {
    /*
     * The master build prompt names this one directly under prohibited
     * shortcuts. It is the whole reason this module exists.
     */
    it("support agents cannot do anything a super admin can do to money or status", () => {
      const support = permissionsOfRole("SUPPORT_AGENT");

      expect(support).not.toContain("wallet.adjust");
      expect(support).not.toContain("withdrawals.review");
      expect(support).not.toContain("users.suspend");
      expect(support).not.toContain("users.close");
      expect(support).not.toContain("admin.roles.manage");
      expect(support).not.toContain("kyc.review");
    });

    it("support agents are read-only throughout", () => {
      for (const permission of permissionsOfRole("SUPPORT_AGENT")) {
        expect(permission.endsWith(".read")).toBe(true);
      }
    });

    /*
     * Someone who can both freeze an account and move its balance can make a
     * money problem disappear on their own.
     */
    it("compliance can stop an account but cannot move its money", () => {
      expect(roleHasPermission("COMPLIANCE_OFFICER", "users.suspend")).toBe(true);
      expect(roleHasPermission("COMPLIANCE_OFFICER", "users.close")).toBe(true);
      expect(roleHasPermission("COMPLIANCE_OFFICER", "wallet.adjust")).toBe(false);
    });

    /*
     * Finance moves money; freezing an account is a compliance or risk call.
     * If finance could do both, nobody is accountable for which happened.
     */
    it("finance can move money but cannot suspend or close accounts", () => {
      expect(roleHasPermission("FINANCE_ADMIN", "wallet.adjust")).toBe(true);
      expect(roleHasPermission("FINANCE_ADMIN", "withdrawals.review")).toBe(true);
      expect(roleHasPermission("FINANCE_ADMIN", "users.suspend")).toBe(false);
      expect(roleHasPermission("FINANCE_ADMIN", "users.close")).toBe(false);
    });

    /*
     * Risk raises signals; compliance acts on the heavy ones. The spec is
     * explicit that a heuristic flag must never be grounds for automatic
     * confiscation, and this split is what keeps the team closest to the
     * heuristics from acting on them alone.
     */
    it("risk can restrict pending investigation but cannot suspend or close", () => {
      expect(roleHasPermission("RISK_OFFICER", "users.restrict")).toBe(true);
      expect(roleHasPermission("RISK_OFFICER", "users.suspend")).toBe(false);
      expect(roleHasPermission("RISK_OFFICER", "users.close")).toBe(false);
      expect(roleHasPermission("RISK_OFFICER", "wallet.adjust")).toBe(false);
    });

    it("only super admin can change who holds what", () => {
      const canManageRoles = ADMIN_ROLES.filter((role) =>
        roleHasPermission(role, "admin.roles.manage"),
      );
      expect(canManageRoles).toEqual(["SUPER_ADMIN"]);
    });

    it("marketing cannot see customer accounts or money", () => {
      const marketing = permissionsOfRole("MARKETING_MANAGER");
      expect(marketing).not.toContain("users.read");
      expect(marketing).not.toContain("wallet.read");
    });
  });

  describe("model integrity", () => {
    it("super admin holds every permission", () => {
      expect([...permissionsOfRole("SUPER_ADMIN")].sort()).toEqual([...PERMISSIONS].sort());
    });

    it("every role grants only permissions that exist", () => {
      for (const role of ADMIN_ROLES) {
        for (const permission of permissionsOfRole(role)) {
          expect(PERMISSIONS).toContain(permission);
        }
      }
    });

    it("no role lists a permission twice", () => {
      for (const role of ADMIN_ROLES) {
        const granted = permissionsOfRole(role);
        expect(new Set(granted).size).toBe(granted.length);
      }
    });

    it("every role has a label and a description", () => {
      for (const role of ADMIN_ROLES) {
        expect(ROLE_LABELS[role]).toBeTruthy();
        expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
      }
    });

    it("every role can do something", () => {
      for (const role of ADMIN_ROLES) {
        expect(permissionsOfRole(role).length).toBeGreaterThan(0);
      }
    });

    /*
     * A permission no role grants is unreachable — either dead, or a gap that
     * will be discovered when somebody needs it at 2am.
     */
    it("every permission is reachable by some role other than super admin", () => {
      const withoutSuper = ADMIN_ROLES.filter((role) => role !== "SUPER_ADMIN");
      const reachable = permissionsForRoles(withoutSuper as AdminRole[]);

      const orphans = PERMISSIONS.filter((permission) => !reachable.has(permission));
      /*
       * Role management is deliberately super-admin-only, so those two are
       * expected orphans. Asserting the exact set — rather than "few" — means
       * a permission that quietly becomes unreachable fails this test instead
       * of being discovered when somebody needs it at 2am.
       */
      expect(orphans).toEqual(["admin.roles.read", "admin.roles.manage"]);
    });
  });

  describe("combining roles", () => {
    it("unions the permissions of every role held", () => {
      const combined = permissionsForRoles(["SUPPORT_AGENT", "FINANCE_ADMIN"]);
      expect(combined.has("wallet.adjust")).toBe(true);
      expect(combined.has("bets.read")).toBe(true);
      // Still not something either role grants.
      expect(combined.has("admin.roles.manage")).toBe(false);
    });

    it("grants nothing for an empty role list", () => {
      expect(permissionsForRoles([]).size).toBe(0);
    });
  });

  describe("step-up re-authentication", () => {
    it("covers every action that moves money or hands out authority", () => {
      expect(requiresReauth("wallet.adjust")).toBe(true);
      expect(requiresReauth("withdrawals.review")).toBe(true);
      expect(requiresReauth("admin.roles.manage")).toBe(true);
      expect(requiresReauth("users.close")).toBe(true);
    });

    it("does not demand a password to read a dashboard", () => {
      expect(requiresReauth("users.read")).toBe(false);
      expect(requiresReauth("reports.read")).toBe(false);
      expect(requiresReauth("exposure.read")).toBe(false);
    });

    it("only names permissions that exist", () => {
      for (const permission of REAUTH_REQUIRED_PERMISSIONS) {
        expect(PERMISSIONS).toContain(permission);
      }
    });
  });
});

describe("admin navigation", () => {
  it("gates every entry on a permission that exists", () => {
    for (const section of ADMIN_NAV) {
      for (const item of section.items) {
        expect(PERMISSIONS).toContain(item.permission);
      }
    }
  });

  it("shows a super admin everything", () => {
    const sections = visibleNav(permissionsForRoles(["SUPER_ADMIN"]));
    const shown = sections.flatMap((section) => section.items).length;
    const total = ADMIN_NAV.flatMap((section) => section.items).length;
    expect(shown).toBe(total);
  });

  it("shows a support agent only what they can open", () => {
    const sections = visibleNav(permissionsForRoles(["SUPPORT_AGENT"]));
    const keys = sections.flatMap((section) => section.items.map((item) => item.key));

    // Reading a withdrawal IS a support agent's job — "where is my money" is
    // the archetypal support call. Seeing it is right; approving it is not,
    // and that is a separate permission they do not hold.
    expect(keys).toContain("users");
    expect(keys).toContain("withdrawals");
    expect(keys).toContain("dashboard");

    expect(keys).not.toContain("roles");
    expect(keys).not.toContain("promotions");
    expect(keys).not.toContain("ledger");
    expect(keys).not.toContain("reconciliation");
    expect(keys).not.toContain("exposure");
    expect(keys).not.toContain("risk");
  });

  /*
   * Regression: the dashboard was once gated on `system.read`, which only a
   * super admin holds — so every other administrator landed in the admin area
   * with no link back to it.
   */
  it("shows every role a way back to the dashboard", () => {
    for (const role of ADMIN_ROLES) {
      const keys = visibleNav(permissionsForRoles([role])).flatMap((section) =>
        section.items.map((item) => item.key),
      );
      expect(keys, `${role} cannot reach the dashboard`).toContain("dashboard");
    }
  });

  it("shows an administrator with no roles nothing at all", () => {
    expect(visibleNav(permissionsForRoles([]))).toEqual([]);
  });

  it("drops sections that end up empty rather than rendering a bare heading", () => {
    for (const section of visibleNav(permissionsForRoles(["MARKETING_MANAGER"]))) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });
});
