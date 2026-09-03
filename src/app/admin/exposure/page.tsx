import { redirect } from "next/navigation";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { exposureService } from "@/modules/risk/exposure.service";
import { naira } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exposure" };

export default async function ExposurePage() {
  try {
    await requirePermission("exposure.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Exposure</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const [alerts, topMarkets, openLiability] = await Promise.all([
    exposureService.alerts(),
    exposureService.topExposedMarkets(20),
    exposureService.totalOpenLiabilityMinor(),
  ]);

  return (
    <>
      <header className="page-head">
        <h1>Exposure</h1>
        <p className="muted">What the book stands to pay out if every open bet wins.</p>
      </header>

      <section className="metrics">
        <div className="card metric">
          <span className="metric-label">Open liability</span>
          <strong className="metric-value">{naira(openLiability)}</strong>
          <span className="muted small">Across all open markets</span>
        </div>
        <div className="card metric">
          <span className="metric-label">Alerts</span>
          <strong className="metric-value">
            {alerts.length > 0 ? (
              <span className="pill critical">{alerts.length}</span>
            ) : (
              alerts.length
            )}
          </strong>
          <span className="muted small">Markets above 80% of ceiling</span>
        </div>
      </section>

      <section className="card">
        <h2>Most exposed markets</h2>
        {topMarkets.length === 0 ? (
          <p className="muted small">No market is carrying liability yet.</p>
        ) : (
          <div className="scroll-x">
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
                      <td className="right">{naira(market.totalLiabilityMinor)}</td>
                      <td className="right muted">{naira(market.ceilingMinor)}</td>
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
          </div>
        )}
      </section>
    </>
  );
}
