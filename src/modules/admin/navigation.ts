import type { Permission } from "./permissions";

/**
 * The admin sidebar.
 *
 * Every entry declares the permission that gates it, so the navigation and the
 * authorisation check cannot drift apart — a link is shown exactly when the
 * page behind it would let you in.
 *
 * Hiding a link is a courtesy, NOT the security control. The page itself calls
 * `requirePermission`. A hidden link that is still reachable by typing the URL
 * would be the classic mistake here.
 */

export interface AdminNavItem {
  key: string;
  label: string;
  href: string;
  permission: Permission;
  /** Route exists and does real work; otherwise it renders a labelled stub. */
  built: boolean;
  /** Phase from the master build prompt that delivers it. */
  phase: number;
}

export interface AdminNavSection {
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: readonly AdminNavSection[] = [
  {
    label: "Overview",
    items: [
      /*
       * Gated on `dashboard.read`, which every role holds, NOT on
       * `system.read`. Gating the landing page on a permission only super
       * admins have left every other administrator inside the admin area with
       * no way back to it. The dashboard's individual tiles are filtered by
       * permission instead, so what each role sees on it still differs.
       */
      { key: "dashboard", label: "Dashboard", href: "/admin", permission: "dashboard.read", built: true, phase: 3 },
    ],
  },
  {
    label: "Users",
    items: [
      { key: "users", label: "Users", href: "/admin/users", permission: "users.read", built: true, phase: 3 },
      { key: "kyc", label: "Verification", href: "/admin/kyc", permission: "kyc.review", built: true, phase: 20 },
      { key: "rg", label: "Responsible Gaming", href: "/admin/responsible", permission: "compliance.read", built: false, phase: 20 },
    ],
  },
  {
    label: "Finance",
    items: [
      { key: "deposits", label: "Deposits", href: "/admin/deposits", permission: "deposits.read", built: true, phase: 5 },
      { key: "withdrawals", label: "Withdrawals", href: "/admin/withdrawals", permission: "withdrawals.read", built: true, phase: 5 },
      { key: "ledger", label: "Ledger", href: "/admin/ledger", permission: "ledger.read", built: false, phase: 5 },
      { key: "reconciliation", label: "Reconciliation", href: "/admin/reconciliation", permission: "reconciliation.read", built: false, phase: 24 },
    ],
  },
  {
    label: "Sportsbook",
    items: [
      { key: "exposure", label: "Exposure", href: "/admin/exposure", permission: "exposure.read", built: true, phase: 3 },
      { key: "bets", label: "Bets", href: "/admin/bets", permission: "bets.read", built: false, phase: 8 },
      { key: "events", label: "Events", href: "/admin/events", permission: "sportsbook.manage", built: false, phase: 6 },
    ],
  },
  {
    label: "Casino",
    items: [
      { key: "casino-games", label: "Games", href: "/admin/casino", permission: "casino.read", built: false, phase: 11 },
    ],
  },
  {
    label: "Risk & Compliance",
    items: [
      { key: "risk", label: "Risk Queue", href: "/admin/risk", permission: "risk.read", built: true, phase: 3 },
      { key: "compliance", label: "Compliance", href: "/admin/compliance", permission: "compliance.read", built: false, phase: 20 },
    ],
  },
  {
    label: "Marketing",
    items: [
      { key: "promotions", label: "Promotions", href: "/admin/promotions", permission: "promotions.manage", built: false, phase: 14 },
    ],
  },
  {
    label: "Platform",
    items: [
      { key: "reports", label: "Reports", href: "/admin/reports", permission: "reports.read", built: true, phase: 3 },
      { key: "roles", label: "Roles & Access", href: "/admin/roles", permission: "admin.roles.read", built: true, phase: 3 },
      { key: "audit", label: "Audit Log", href: "/admin/audit", permission: "audit.read", built: true, phase: 3 },
    ],
  },
];

/** The sidebar as one particular administrator should see it. */
export function visibleNav(permissions: Set<Permission>): AdminNavSection[] {
  return ADMIN_NAV.map((section) => ({
    label: section.label,
    items: section.items.filter((item) => permissions.has(item.permission)),
  })).filter((section) => section.items.length > 0);
}
