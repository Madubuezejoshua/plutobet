import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { productReconciliationService } from "@/modules/reconciliation/product-reconciliation.service";
import { guardAdminPage } from "../_guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reconciliation" };

/**
 * Financial integrity, asked live rather than read from a cached report.
 *
 * Two independent questions, and both must be asked because either can pass
 * while the other fails:
 *
 *   Wallet reconciliation  — does each balance match a replay of its entries?
 *   Product reconciliation — does each domain record match the money that
 *                            moved for it?
 *
 * A wallet can reconcile perfectly while a bet exists whose stake was never
 * debited. The balance is internally consistent; the RELATIONSHIP between the
 * domain and the ledger has broken, and only the second check sees it.
 *
 * EVERY FINDING IS A BUG, NOT A DISCREPANCY TO EXPLAIN. The live constraints
 * already prevent all of them, so a row here means a guard is missing or was
 * bypassed. The right response is to investigate the code, never to adjust
 * the number.
 */
export default async function AdminReconciliationPage() {
  const guard = await guardAdminPage("reconciliation.read", "Reconciliation");
  if (!guard.ok) return guard.denied;

  const report = await productReconciliationService.run();

  const [wallets] = await db.execute<{
    total: number;
    flagged: number;
    checked: number;
  }>(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE reconciliation_status = 'FLAGGED')::int AS flagged,
      count(*) FILTER (WHERE reconciliation_checked_at IS NOT NULL)::int AS checked
    FROM wallets
  `);

  const flaggedWallets = await db.execute<{
    id: string;
    kind: string;
    bucket: string | null;
    email: string | null;
    balance_minor: string;
  }>(sql`
    SELECT w.id::text, w.kind::text, w.bucket::text, u.email,
           w.cached_balance_minor::text
    FROM wallets w
    LEFT JOIN users u ON u.id = w.user_id
    WHERE w.reconciliation_status = 'FLAGGED'
    LIMIT 50
  `);

  const clean = report.clean && Number(wallets?.flagged ?? 0) === 0;

  return (
    <>
      <header className="page-head">
        <h1>Reconciliation</h1>
        <p className="muted">
          Checked live, just now — not a cached overnight report.
        </p>
      </header>

      <p className={clean ? "notice ok" : "notice error"}>
        {clean
          ? "All checks passed. Every balance replays from its own entries, and every domain record has the money movement behind it."
          : "Findings below. Each one is a bug — the live constraints already prevent all of them, so a row here means a guard was missed or bypassed. Investigate the code; do not adjust the figures."}
      </p>

      <section>
        <h2>Wallet balances</h2>
        <p className="muted">
          {wallets?.total ?? 0} wallets · {wallets?.checked ?? 0} reconciled at least once ·{" "}
          <strong>{wallets?.flagged ?? 0} flagged</strong>
        </p>

        {flaggedWallets.length > 0 ? (
          <div className="table-scroll">
            <table className="statement">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Owner</th>
                  <th>Bucket</th>
                  <th className="right">Recorded balance</th>
                </tr>
              </thead>
              <tbody>
                {flaggedWallets.map((wallet) => (
                  <tr key={wallet.id}>
                    <td className="muted">{wallet.kind.toLowerCase()}</td>
                    <td>{wallet.email ?? "system"}</td>
                    <td className="muted">{wallet.bucket?.toLowerCase() ?? "—"}</td>
                    <td className="right">{wallet.balance_minor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section>
        <h2>Domain against ledger</h2>

        {report.findings.length === 0 ? (
          <p className="muted">
            No findings. Checked: bets without a stake debit · paid withdrawals without a
            debit · succeeded deposits never credited · won bets without a payout · casino
            payouts without a round · bonus grants outside a BONUS wallet.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="statement">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Severity</th>
                  <th className="right">Count</th>
                  <th>What it means</th>
                </tr>
              </thead>
              <tbody>
                {report.findings.map((finding) => (
                  <tr key={finding.check}>
                    <td>{finding.check.toLowerCase().replace(/_/g, " ")}</td>
                    <td>
                      <span
                        className={finding.severity === "CRITICAL" ? "pill critical" : "pill warning"}
                      >
                        {finding.severity.toLowerCase()}
                      </span>
                    </td>
                    <td className="right">{finding.count}</td>
                    <td className="muted">
                      {finding.detail}
                      {finding.sample.length ? (
                        <div style={{ fontSize: "0.75rem", opacity: 0.7, marginTop: "0.25rem" }}>
                          e.g. {finding.sample.slice(0, 3).join(", ")}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Checked at {report.checkedAt.toLocaleString()}.
      </p>
    </>
  );
}
