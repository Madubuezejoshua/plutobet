import { redirect } from "next/navigation";
import { AdminRequiredError, requireAdmin } from "@/modules/auth/admin";
import { exposureService } from "@/modules/risk/exposure.service";
import { reportingService } from "@/modules/reporting/reporting.service";

export const dynamic = "force-dynamic";

function formatNaira(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  const naira = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₦${naira}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * Trading and compliance overview.
 *
 * Read-only by design. Everything that moves money lives behind its own
 * action with re-authentication and a mandatory reason (§3.14), so a
 * dashboard left open on an unlocked screen exposes information, not funds.
 */
export default async function AdminPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/api/auth/signin");
    throw error;
  }

  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60_000);

  const [alerts, topMarkets, openLiability, turnover, signals] = await Promise.all([
    exposureService.alerts(),
    exposureService.topExposedMarkets(10),
    exposureService.totalOpenLiabilityMinor(),
    reportingService.dailyTurnover({ from, to: now }),
    exposureService.allSignals(),
  ]);

  const week = turnover.reduce(
    (total, day) => total + BigInt(day.grossGamingRevenueMinor),
    0n,
  );

  return (
    <main className="shell">
      <nav className="nav" aria-label="Primary navigation">
        <div className="brand">Bet Platform · Admin</div>
        <div className="nav-links">
          <a href="/admin">Overview</a>
          <a href="/admin/reports">Reports</a>
          <a href="/sports">Site</a>
        </div>
      </nav>

      <header className="page-head">
        <h1>Trading overview</h1>
        <p className="muted">Live liability, exposure alerts, and risk signals.</p>
      </header>

      <section className="metrics">
        <div className="card metric">
          <span className="metric-label">Open liability</span>
          <strong className="metric-value">{formatNaira(openLiability)}</strong>
          <span className="muted small">Across all open markets</span>
        </div>
        <div className="card metric">
          <span className="metric-label">GGR · 7 days</span>
          <strong className="metric-value">{formatNaira(week)}</strong>
          <span className="muted small">Stakes less payouts and refunds</span>
        </div>
        <div className="card metric">
          <span className="metric-label">Exposure alerts</span>
          <strong className="metric-value">{alerts.length}</strong>
          <span className="muted small">Markets above 80% of ceiling</span>
        </div>
        <div className="card metric">
          <span className="metric-label">Risk signals</span>
          <strong className="metric-value">{signals.length}</strong>
          <span className="muted small">For review — no automatic action</span>
        </div>
      </section>

      <section className="card">
        <h2>Exposure</h2>
        {topMarkets.length === 0 ? (
          <p className="muted small">No market is carrying liability yet.</p>
        ) : (
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">Fixture</th>
                <th scope="col">Market</th>
                <th scope="col" className="right">Liability</th>
                <th scope="col" className="right">Ceiling</th>
                <th scope="col" className="right">Used</th>
              </tr>
            </thead>
            <tbody>
              {topMarkets.map((market) => {
                const alert = alerts.find((a) => a.marketId === market.marketId);
                return (
                  <tr key={market.marketId}>
                    <td>{market.fixture}</td>
                    <td className="muted">{market.marketKey}</td>
                    <td className="right">{formatNaira(market.totalLiabilityMinor)}</td>
                    <td className="right muted">{formatNaira(market.ceilingMinor)}</td>
                    <td className="right">
                      <span
                        className={
                          alert?.severity === "CRITICAL"
                            ? "pill critical"
                            : alert
                              ? "pill warning"
                              : "pill"
                        }
                      >
                        {market.utilisationPercent.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Risk signals</h2>
        <p className="muted small">
          Heuristics only. Shared addresses and staking bursts have innocent explanations —
          these are for a human to judge, never grounds for automatic suspension.
        </p>
        {signals.length === 0 ? (
          <p className="muted small">Nothing flagged.</p>
        ) : (
          <ul className="signals">
            {signals.map((signal, index) => (
              <li key={`${signal.kind}-${index}`}>
                <span className={`pill ${signal.severity === "HIGH" ? "critical" : "warning"}`}>
                  {signal.severity}
                </span>
                <span>{signal.detail}</span>
                <span className="muted small">
                  {signal.userIds.length} account{signal.userIds.length === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
