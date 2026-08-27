import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/pooled";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { isLivePaymentRail } from "@/modules/payments/factory";
import { naira } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deposits" };

/**
 * Deposit history.
 *
 * Read-only, and deliberately so. There is no "mark as paid" button: a
 * deposit is credited by a signed provider webhook or not at all. An admin
 * control that credits a wallet because someone says the money arrived is the
 * exact shortcut the build rules prohibit, and it is also how an operator
 * gets socially engineered.
 *
 * Correcting a genuine mishap is a manual adjustment — its own permission,
 * its own reason, its own audit row.
 */
export default async function AdminDepositsPage() {
  try {
    await requirePermission("deposits.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/api/auth/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Deposits</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const rows = await db.execute<{
    id: string;
    email: string | null;
    amount_minor: string;
    status: string;
    provider: string;
    provider_ref: string;
    credited_txn_id: string | null;
    created_at: Date;
  }>(sql`
    SELECT p.id, u.email, p.amount_minor::text AS amount_minor, p.status::text AS status,
           p.provider, p.provider_ref, p.credited_txn_id, p.created_at
    FROM payment_intents p
    LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC
    LIMIT 200
  `);

  const succeeded = rows.filter((row) => row.status === "SUCCEEDED");
  const total = succeeded.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);

  return (
    <>
      <header className="page-head">
        <h1>Deposits</h1>
        <p className="muted">Most recent 200 · {naira(total)} credited in this window</p>
      </header>

      {!isLivePaymentRail() ? (
        <p className="notice warn">
          <strong>Sandbox rail.</strong> No <code>PAYSTACK_SECRET_KEY</code> is configured, so no
          real deposits can arrive.
        </p>
      ) : null}

      <section className="card">
        <p className="muted small">
          A deposit is credited by a signed provider webhook or not at all — there is deliberately
          no way to credit one from this screen. Fixing a genuine mishap is a manual adjustment,
          with its own permission and audit trail.
        </p>

        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Account</th>
                <th scope="col">Provider ref</th>
                <th scope="col" className="right">Amount</th>
                <th scope="col" className="right">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No deposits recorded yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td className="muted small">
                      {new Date(row.created_at).toLocaleString("en-NG")}
                    </td>
                    <td>
                      {row.email ?? <span className="muted">unattributed</span>}
                      <br />
                      <span className="muted small">{row.provider}</span>
                    </td>
                    <td className="muted small">{row.provider_ref}</td>
                    <td className="right">{naira(BigInt(row.amount_minor))}</td>
                    <td className="right">
                      <span
                        className={
                          row.status === "SUCCEEDED"
                            ? "pill ok"
                            : row.status === "FAILED"
                              ? "pill critical"
                              : "pill warning"
                        }
                      >
                        {row.status}
                      </span>
                      {row.status === "SUCCEEDED" && !row.credited_txn_id ? (
                        <>
                          <br />
                          {/* Succeeded but never credited is a real problem,
                              not a display quirk — it means the ledger write
                              did not happen. */}
                          <span className="pill critical">NOT CREDITED</span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
