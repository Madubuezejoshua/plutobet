import { redirect } from "next/navigation";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { exposureService } from "@/modules/risk/exposure.service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Risk Queue" };

export default async function RiskPage() {
  try {
    await requirePermission("risk.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Risk Queue</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const signals = await exposureService.allSignals();

  return (
    <>
      <header className="page-head">
        <h1>Risk Queue</h1>
        <p className="muted">{signals.length} signals for review</p>
      </header>

      <section className="card">
        <h2>Signals</h2>
        <p className="muted small">
          Heuristics only. Shared addresses and staking bursts have innocent explanations — a
          family on one connection looks identical to collusion from here. These are for a human
          to judge, and are never grounds for automatic suspension or for holding a balance.
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

        <p className="muted small legal">
          Acting on a signal — restricting an account pending investigation — needs the
          <code> users.restrict</code> permission and arrives with the compliance tooling in
          phase 20. Risk raises; compliance acts. Keeping those apart is the point of having two
          roles.
        </p>
      </section>
    </>
  );
}
