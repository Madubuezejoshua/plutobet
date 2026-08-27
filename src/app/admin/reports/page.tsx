import { redirect } from "next/navigation";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { reportingService } from "@/modules/reporting/reporting.service";

export const dynamic = "force-dynamic";

function formatNaira(minor: string): string {
  const value = BigInt(minor);
  const naira = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `₦${naira}.${(value % 100n).toString().padStart(2, "0")}`;
}

/**
 * Regulator and AML reporting.
 *
 * Figures come from the ledger rather than a reporting table, so anything
 * shown here reconciles against the transaction record a lab or regulator
 * would be given.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  try {
    await requirePermission("reports.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/api/auth/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Reporting</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const params = await searchParams;
  const days = Math.min(Math.max(Number(params.days ?? 30) || 30, 1), 365);
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60_000);

  const [turnover, large] = await Promise.all([
    reportingService.dailyTurnover({ from, to }),
    reportingService.largeTransactions({ from, to }),
  ]);

  const totals = turnover.reduce(
    (sum, day) => ({
      deposits: sum.deposits + BigInt(day.depositsMinor),
      withdrawals: sum.withdrawals + BigInt(day.withdrawalsMinor),
      stakes: sum.stakes + BigInt(day.stakesMinor),
      payouts: sum.payouts + BigInt(day.payoutsMinor),
      ggr: sum.ggr + BigInt(day.grossGamingRevenueMinor),
    }),
    { deposits: 0n, withdrawals: 0n, stakes: 0n, payouts: 0n, ggr: 0n },
  );

  return (
    <>
      <header className="page-head">
        <h1>Reporting</h1>
        <p className="muted">Last {days} days · derived from the ledger</p>
      </header>

      <section className="metrics">
        <div className="card metric">
          <span className="metric-label">Deposits</span>
          <strong className="metric-value">{formatNaira(totals.deposits.toString())}</strong>
        </div>
        <div className="card metric">
          <span className="metric-label">Withdrawals</span>
          <strong className="metric-value">{formatNaira(totals.withdrawals.toString())}</strong>
        </div>
        <div className="card metric">
          <span className="metric-label">Turnover</span>
          <strong className="metric-value">{formatNaira(totals.stakes.toString())}</strong>
        </div>
        <div className="card metric">
          <span className="metric-label">GGR</span>
          <strong className="metric-value">{formatNaira(totals.ggr.toString())}</strong>
          <span className="muted small">Duty is normally assessed on this</span>
        </div>
      </section>

      <section className="card">
        <h2>Daily turnover</h2>
        <p className="muted small">
          Deposits and withdrawals are shown for completeness but are excluded from GGR —
          money entering a wallet is not revenue.
        </p>
        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="right">Deposits</th>
                <th scope="col" className="right">Withdrawals</th>
                <th scope="col" className="right">Stakes</th>
                <th scope="col" className="right">Payouts</th>
                <th scope="col" className="right">GGR</th>
              </tr>
            </thead>
            <tbody>
              {turnover.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">No activity in this period.</td>
                </tr>
              ) : (
                turnover.map((day) => (
                  <tr key={day.day}>
                    <td>{day.day}</td>
                    <td className="right">{formatNaira(day.depositsMinor)}</td>
                    <td className="right">{formatNaira(day.withdrawalsMinor)}</td>
                    <td className="right">{formatNaira(day.stakesMinor)}</td>
                    <td className="right">{formatNaira(day.payoutsMinor)}</td>
                    <td className="right credit">{formatNaira(day.grossGamingRevenueMinor)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Large transactions</h2>
        <p className="muted small">
          At or above ₦5,000,000, for AML/SCUML review. The verification level sits beside each
          amount because an unverified account moving this much is the case worth opening.
        </p>
        {large.length === 0 ? (
          <p className="muted small">Nothing above the threshold.</p>
        ) : (
          <div className="scroll-x">
            <table className="statement">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Account</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="right">Amount</th>
                  <th scope="col" className="right">KYC</th>
                </tr>
              </thead>
              <tbody>
                {large.map((row) => (
                  <tr key={`${row.transactionId}-${row.direction}`}>
                    <td>{new Date(row.createdAt).toLocaleDateString("en-NG")}</td>
                    <td className="muted">{row.email ?? row.userId}</td>
                    <td>{row.type}</td>
                    <td className="right">{formatNaira(row.amountMinor)}</td>
                    <td className="right">
                      <span className={row.kycLevel && row.kycLevel >= 2 ? "pill" : "pill critical"}>
                        {row.kycLevel ?? 0}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
