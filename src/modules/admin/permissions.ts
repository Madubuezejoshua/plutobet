/**
 * Admin roles and what each one may do.
 *
 * WHY PERMISSIONS LIVE IN CODE AND ROLES LIVE IN THE DATABASE
 *
 * Role *assignments* are data — they change per person, need an audit trail,
 * and an operator must be able to grant one without a deploy. They are rows.
 *
 * The role → permission *mapping* is not data. Every permission string here is
 * checked by a specific line of code somewhere; a permission that exists in a
 * table but that no route consults is a promise the system does not keep, and
 * the failure is silent. Keeping the map in TypeScript means the compiler
 * refuses a typo, the set is exhaustive by construction, and a reviewer can
 * see the whole authority model in one file.
 *
 * The trade is that changing what a role may do requires a deploy. That is the
 * right way round: widening a role's authority is a decision that deserves
 * code review, not a dropdown.
 *
 * THE NAMING RULE
 * `subject.verb`. Read permissions end in `.read`, mutations name the specific
 * action. There is deliberately no wildcard — SUPER_ADMIN is enumerated like
 * everything else, so reading this file tells you exactly what it can do.
 */

export const ADMIN_ROLES = [
  "SUPER_ADMIN",
  "FINANCE_ADMIN",
  "SPORTSBOOK_MANAGER",
  "CASINO_MANAGER",
  "COMPLIANCE_OFFICER",
  "RISK_OFFICER",
  "SUPPORT_AGENT",
  "MARKETING_MANAGER",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PERMISSIONS = [
  // users
  "users.read",
  "users.suspend",
  "users.restrict",
  "users.close",
  // money
  "wallet.read",
  "wallet.adjust",
  "deposits.read",
  "withdrawals.read",
  "withdrawals.review",
  "ledger.read",
  "reconciliation.read",
  // sportsbook
  "sportsbook.read",
  "sportsbook.manage",
  "bets.read",
  "bets.settle",
  "exposure.read",
  // casino
  "casino.read",
  "casino.manage",
  // compliance
  "compliance.read",
  "compliance.review",
  "kyc.read",
  "kyc.review",
  // risk
  "risk.read",
  "risk.review",
  // marketing
  "promotions.read",
  "promotions.manage",
  // platform
  "dashboard.read",
  "reports.read",
  "system.read",
  "audit.read",
  "admin.roles.read",
  "admin.roles.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The authority model.
 *
 * Two principles applied throughout:
 *
 *  1. READ IS NOT WRITE. A support agent can see a withdrawal to answer
 *     "where is my money"; approving one is a finance decision. Conflating
 *     them is how a phone call becomes a payout.
 *
 *  2. NOBODY REVIEWS THEMSELVES. The officer who flags an account is not the
 *     one who suspends it — risk raises signals, compliance acts. Separating
 *     them is the whole point of having two roles.
 */
const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  /*
   * Everything, including the ability to change who holds what. This is the
   * only role that can escalate privilege, so it should be held by as few
   * people as the operation can tolerate.
   */
  SUPER_ADMIN: PERMISSIONS,

  /*
   * Money in and money out. Deliberately NOT given users.suspend: freezing an
   * account is a compliance or risk call, and finance being able to do it as
   * well would blur who is accountable for it.
   */
  FINANCE_ADMIN: [
    "dashboard.read",
    "users.read",
    "wallet.read",
    "wallet.adjust",
    "deposits.read",
    "withdrawals.read",
    "withdrawals.review",
    "ledger.read",
    "reconciliation.read",
    "reports.read",
    "audit.read",
    "system.read",
  ],

  SPORTSBOOK_MANAGER: [
    "dashboard.read",
    "sportsbook.read",
    "sportsbook.manage",
    "bets.read",
    "bets.settle",
    "exposure.read",
    "reports.read",
    "users.read",
    "system.read",
  ],

  CASINO_MANAGER: ["dashboard.read", "casino.read", "casino.manage", "reports.read", "users.read"],

  /*
   * The regulatory role: KYC decisions, restrictions, closures.
   *
   * Has users.suspend and users.close but NOT wallet.adjust — a compliance
   * officer can stop an account, and cannot move its money. Someone who could
   * do both could quietly make a balance problem disappear.
   */
  COMPLIANCE_OFFICER: [
    "dashboard.read",
    "users.read",
    "users.suspend",
    "users.restrict",
    "users.close",
    "compliance.read",
    "compliance.review",
    "kyc.read",
    "kyc.review",
    "wallet.read",
    "withdrawals.read",
    "ledger.read",
    "reports.read",
    "audit.read",
  ],

  /*
   * Raises and reviews risk signals, and can restrict an account pending
   * investigation. Cannot suspend or close: those are heavier, and belong to
   * compliance. The spec is explicit that an AI or heuristic flag must never
   * be grounds for automatic confiscation, and this split is what stops the
   * team closest to the heuristics from acting on them alone.
   */
  RISK_OFFICER: [
    "dashboard.read",
    "users.read",
    "users.restrict",
    "risk.read",
    "risk.review",
    "exposure.read",
    "bets.read",
    "wallet.read",
    "withdrawals.read",
    "reports.read",
  ],

  /*
   * Read-only, plus nothing that touches money or status.
   *
   * This is the role the master build prompt calls out by name: a support
   * agent must not have super-admin authority. They can see enough to answer
   * a question and nothing that changes an outcome.
   */
  SUPPORT_AGENT: [
    "dashboard.read",
    "users.read",
    "wallet.read",
    "deposits.read",
    "withdrawals.read",
    "bets.read",
    "kyc.read",
  ],

  MARKETING_MANAGER: ["dashboard.read", "promotions.read", "promotions.manage", "reports.read"],
};

/** Human-readable names for the admin UI. */
export const ROLE_LABELS: Record<AdminRole, string> = {
  SUPER_ADMIN: "Super Admin",
  FINANCE_ADMIN: "Finance Admin",
  SPORTSBOOK_MANAGER: "Sportsbook Manager",
  CASINO_MANAGER: "Casino Manager",
  COMPLIANCE_OFFICER: "Compliance Officer",
  RISK_OFFICER: "Risk Officer",
  SUPPORT_AGENT: "Support Agent",
  MARKETING_MANAGER: "Marketing Manager",
};

export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  SUPER_ADMIN: "Full authority, including granting and revoking roles.",
  FINANCE_ADMIN: "Deposits, withdrawals, ledger and manual adjustments.",
  SPORTSBOOK_MANAGER: "Fixtures, markets, exposure and bet settlement.",
  CASINO_MANAGER: "Casino games, providers and rounds.",
  COMPLIANCE_OFFICER: "KYC decisions, account restrictions and AML review.",
  RISK_OFFICER: "Risk signals, exposure and fraud investigation.",
  SUPPORT_AGENT: "Read-only access for answering customer questions.",
  MARKETING_MANAGER: "Promotions, campaigns and bonuses.",
};

/**
 * Actions that additionally require step-up re-authentication.
 *
 * A long-lived session is fine for reading a dashboard and not fine for moving
 * money or handing out authority. These are the permissions where an unlocked
 * laptop must not be enough.
 */
export const REAUTH_REQUIRED_PERMISSIONS: readonly Permission[] = [
  "wallet.adjust",
  "withdrawals.review",
  "admin.roles.manage",
  "users.close",
];

export function permissionsForRoles(roles: readonly AdminRole[]): Set<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return granted;
}

export function roleHasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsOfRole(role: AdminRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function requiresReauth(permission: Permission): boolean {
  return REAUTH_REQUIRED_PERMISSIONS.includes(permission);
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}
