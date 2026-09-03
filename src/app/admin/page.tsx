import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { dashboardService, type HealthState } from "@/modules/admin/dashboard.service";
import { naira, nairaCompact } from "@/lib/money";

export const dynamic = "force-dynamic";

const HEALTH_PILL: Record<HealthState, string> = {
  OK: "pill ok",
  DEGRADED: "pill warning",
  DOWN: "pill critical",
  UNKNOWN: "pill",
};

/**
 * Admin dashboard.
 *
 * Read-only by design. Everything that moves money or grants authority lives
 * behind its own action with a mandatory reason and, for the sensitive ones,
 * step-up re-authentication — so a dashboard left open on an unlocked screen
 * exposes information, not funds.
 *
 * Tiles are filtered by permission: a support agent sees the user counts and
 * not the money.
 */
export default async function AdminDashboardPage() {
  let identity;
  try {
    identity = await requirePermission("dashboard.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Dashboard</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const can = (permission: Parameters<typeof identity.permissions.has>[0]) =>
    identity.permissions.has(permission);

  const [metrics, health] = await Promise.all([
    dashboardService.metrics().catch((error: unknown) => {
      console.error("[admin] metrics unavailable", error);
      return null;
    }),
    dashboardService.health(),
  ]);

  return (
    <>
      <header className="page-head">
        <h1>Dashboard</h1>
        <p className="muted">Figures are read from the ledger, not a metrics table.</p>
      </header>

      {metrics === null ? (
        <p className="notice error">
          Metrics are unavailable — the database did not respond. See system health below.
        </p>
      ) : (
        <>
          <section className="metrics">
            {can("users.read") ? (
              <>
                <div className="card metric">
                  <span className="metric-label">Users</span>
                  <strong className="metric-value">{metrics.users.total.toLocaleString()}</strong>
                  <span className="muted small">{metrics.users.newToday} new today</span>
                </div>
                <div className="card metric">
                  <span className="metric-label">Not active</span>
                  <strong className="metric-value">{metrics.users.suspended}</strong>
                  <span className="muted small">Suspended, restricted or closed</span>
                </div>
              </>
            ) : null}

            {can("deposits.read") ? (
              <div className="card metric">
                <span className="metric-label">Deposits today</span>
                <strong className="metric-value">
                  {nairaCompact(metrics.money.depositsTodayMinor)}
                </strong>
                <span className="muted small">{naira(metrics.money.depositsTodayMinor)}</span>
              </div>
            ) : null}

            {can("withdrawals.read") ? (
              <div className="card metric">
                <span className="metric-label">Withdrawals today</span>
                <strong className="metric-value">
                  {nairaCompact(metrics.money.withdrawalsTodayMinor)}
                </strong>
                <span className="muted small">{naira(metrics.money.withdrawalsTodayMinor)}</span>
              </div>
            ) : null}

            {can("bets.read") ? (
              <>
                <div className="card metric">
                  <span className="metric-label">Stakes today</span>
                  <strong className="metric-value">
                    {nairaCompact(metrics.money.stakesTodayMinor)}
                  </strong>
                  <span className="muted small">Turnover</span>
                </div>
                <div className="card metric">
                  <span className="metric-label">Payouts today</span>
                  <strong className="metric-value">
                    {nairaCompact(metrics.money.payoutsTodayMinor)}
                  </strong>
                  <span className="muted small">
                    GGR {nairaCompact(metrics.money.stakesTodayMinor - metrics.money.payoutsTodayMinor)}
                  </span>
                </div>
              </>
            ) : null}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Needs attention</h2>
            </div>
            <div className="metrics">
              {can("withdrawals.read") ? (
                <div className="card metric">
                  <span className="metric-label">Pending withdrawals</span>
                  <strong className="metric-value">
                    <span className={metrics.queues.pendingWithdrawals > 0 ? "" : "muted"}>
                      {metrics.queues.pendingWithdrawals}
                    </span>
                  </strong>
                  <span className="muted small">Requested or approved, not yet paid</span>
                </div>
              ) : null}

              {can("kyc.read") ? (
                <div className="card metric">
                  <span className="metric-label">Pending KYC</span>
                  <strong className="metric-value">{metrics.queues.pendingKyc}</strong>
                  {can("kyc.review") && metrics.queues.pendingKyc > 0 ? (
                    <Link href="/admin/kyc" className="muted small">
                      Review →
                    </Link>
                  ) : (
                    <span className="muted small">Documents awaiting a decision</span>
                  )}
                </div>
              ) : null}

              {can("reconciliation.read") ? (
                <div className="card metric">
                  <span className="metric-label">Flagged wallets</span>
                  <strong className="metric-value">
                    {metrics.queues.flaggedWallets > 0 ? (
                      <span className="pill critical">{metrics.queues.flaggedWallets}</span>
                    ) : (
                      0
                    )}
                  </strong>
                  <span className="muted small">Cached balance diverged from the ledger</span>
                </div>
              ) : null}
            </div>
          </section>
        </>
      )}

      {can("system.read") ? (
        <section className="card">
          <h2>System health</h2>
          <p className="muted small">
            Only the database and cache are actually probed. Everything else reports
            <strong> unknown</strong> rather than a green tick it has not earned — a dashboard
            that reassures you about something it never checked is worse than one that admits it.
          </p>
          <ul className="health-list">
            {health.map((check) => (
              <li key={check.component}>
                <span className={HEALTH_PILL[check.state]}>{check.state}</span>
                <span className="component">{check.component}</span>
                <span className="detail">{check.detail}</span>
                {check.latencyMs !== null ? (
                  <span className="muted small">{check.latencyMs}ms</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
