import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { naira } from "@/lib/money";
import { guardAdminPage } from "../_guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compliance" };

/**
 * The compliance picture in one place: verification, age, and large movements.
 *
 * Nothing here is actionable. Reviewing a document happens on the Verification
 * screen, where the reviewer sees the document itself; approving from a
 * summary count would be approving something nobody looked at.
 *
 * Identity documents are never shown, and neither is a BVN or NIN. They are
 * stored as an HMAC digest under a server-held pepper and cannot be recovered
 * from the database at all — which is the point.
 */
export default async function AdminCompliancePage() {
  const guard = await guardAdminPage("compliance.read", "Compliance");
  if (!guard.ok) return guard.denied;

  const kyc = await db.execute<{ status: string; n: number }>(sql`
    SELECT status::text, count(*)::int AS n
    FROM kyc_records GROUP BY status ORDER BY 2 DESC
  `);

  const [tiers] = await db.execute<{
    tier0: number;
    tier1: number;
    tier2: number;
    no_dob: number;
    total: number;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE kyc_level = 0)::int AS tier0,
      count(*) FILTER (WHERE kyc_level = 1)::int AS tier1,
      count(*) FILTER (WHERE kyc_level >= 2)::int AS tier2,
      count(*) FILTER (WHERE date_of_birth IS NULL)::int AS no_dob,
      count(*)::int AS total
    FROM users
  `);

  const [stale] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM kyc_records
    WHERE status = 'PENDING' AND document_key IS NOT NULL
      AND created_at < now() - INTERVAL '48 hours'
  `);

  const large = await db.execute<{
    id: string;
    email: string;
    type: string;
    amount_minor: string;
    created_at: Date;
  }>(sql`
    SELECT t.id::text, u.email, t.type::text,
           e.amount_minor::text, t.created_at
    FROM ledger_transactions t
    JOIN ledger_entries e ON e.txn_id = t.id
    JOIN wallets w ON w.id = e.wallet_id
    JOIN users u ON u.id = w.user_id
    WHERE t.type IN ('DEPOSIT', 'WITHDRAWAL')
      AND e.amount_minor >= 100000000
    ORDER BY t.created_at DESC
    LIMIT 50
  `);

  return (
    <>
      <header className="page-head">
        <h1>Compliance</h1>
        <p className="muted">
          Verification, age assurance, and movements above ₦1,000,000.
        </p>
      </header>

      {Number(stale?.n ?? 0) > 0 ? (
        <p className="notice error">
          <strong>{stale!.n} documents unreviewed for over 48 hours.</strong> A customer
          waiting two days to verify is a customer who cannot withdraw their own money.
        </p>
      ) : null}

      {Number(tiers?.no_dob ?? 0) > 0 ? (
        <p className="notice error">
          <strong>{tiers!.no_dob} accounts have no date of birth.</strong> These predate the
          age gate. They are flagged on their account page but <em>not blocked</em> — decide
          whether to block them or require it at next login.
        </p>
      ) : null}

      <section className="tiles">
        <div className="tile">
          <span className="tile-label">Tier 0 — unverified</span>
          <span className="tile-value">{tiers?.tier0 ?? 0}</span>
          <span className="muted">₦0 withdrawal cap</span>
        </div>
        <div className="tile">
          <span className="tile-label">Tier 1</span>
          <span className="tile-value">{tiers?.tier1 ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Tier 2+</span>
          <span className="tile-value">{tiers?.tier2 ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Accounts</span>
          <span className="tile-value">{tiers?.total ?? 0}</span>
        </div>
      </section>

      <section>
        <h2>Verification queue</h2>
        {kyc.length === 0 ? (
          <p className="muted">No verification records yet.</p>
        ) : (
          <table className="statement">
            <tbody>
              {kyc.map((row) => (
                <tr key={row.status}>
                  <td>{row.status.toLowerCase()}</td>
                  <td className="right">{row.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Large transactions</h2>
        <p className="muted">
          Deposits and withdrawals of ₦1,000,000 or more. Reportable under most AML regimes.
        </p>
        {large.length === 0 ? (
          <p className="muted">None recorded.</p>
        ) : (
          <div className="table-scroll">
            <table className="statement">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Customer</th>
                  <th>Type</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {large.map((row) => (
                  <tr key={row.id}>
                    <td className="muted">{new Date(row.created_at).toLocaleString()}</td>
                    <td>{row.email}</td>
                    <td>{row.type.toLowerCase()}</td>
                    <td className="right">{naira(BigInt(row.amount_minor))}</td>
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
