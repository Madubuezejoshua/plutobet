import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/pooled";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { naira } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

/**
 * Customer search.
 *
 * Read-only in this phase. Suspending, restricting and closing accounts are
 * separate actions with their own permissions and reason requirements, and
 * they belong with the compliance work in phase 20 rather than being bolted
 * onto a list view.
 *
 * The balance column is gated on `wallet.read`, so a role that can identify a
 * customer cannot necessarily see what they hold.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  let identity;
  try {
    identity = await requirePermission("users.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Users</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const canSeeMoney = identity.permissions.has("wallet.read");
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? "";

  const rows = await db.execute<{
    id: string;
    email: string;
    username: string | null;
    status: string;
    risk_status: string;
    kyc_level: number;
    created_at: Date;
    balance_minor: string | null;
  }>(sql`
    SELECT u.id, u.email, u.username, u.status::text AS status,
           u.risk_status::text AS risk_status, u.kyc_level, u.created_at,
           ${canSeeMoney ? sql`w.cached_balance_minor::text` : sql`NULL::text`} AS balance_minor
    FROM users u
    LEFT JOIN wallets w
      ON w.user_id = u.id AND w.kind = 'USER' AND w.currency = 'NGN'
    WHERE u.role = 'USER'
      AND (${query === ""}
           OR u.email LIKE ${`%${query}%`}
           OR u.username LIKE ${`%${query}%`}
           OR u.phone_number LIKE ${`%${query}%`})
    ORDER BY u.created_at DESC
    LIMIT 100
  `);

  return (
    <>
      <header className="page-head">
        <h1>Users</h1>
        <p className="muted">
          {query ? `Matching “${query}”` : "Most recent 100 accounts"}
        </p>
      </header>

      <section className="card">
        <form method="get" style={{ marginBottom: 14 }}>
          <label className="field" style={{ marginBottom: 0 }}>
            Search
            <input
              name="q"
              defaultValue={query}
              placeholder="Email, username or phone number"
            />
          </label>
        </form>

        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Status</th>
                <th scope="col">KYC</th>
                <th scope="col">Risk</th>
                {canSeeMoney ? <th scope="col" className="right">Balance</th> : null}
                <th scope="col" className="right">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={canSeeMoney ? 6 : 5} className="muted">
                    No accounts match.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.email}
                      {row.username ? (
                        <>
                          <br />
                          <span className="muted small">@{row.username}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <span className={row.status === "ACTIVE" ? "pill ok" : "pill critical"}>
                        {row.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td>
                      <span className={Number(row.kyc_level) >= 1 ? "pill" : "pill warning"}>
                        {row.kyc_level}
                      </span>
                    </td>
                    <td>
                      <span
                        className={
                          row.risk_status === "HIGH"
                            ? "pill critical"
                            : row.risk_status === "WATCH"
                              ? "pill warning"
                              : "pill"
                        }
                      >
                        {row.risk_status}
                      </span>
                    </td>
                    {canSeeMoney ? (
                      <td className="right">
                        {row.balance_minor === null ? "—" : naira(BigInt(row.balance_minor))}
                      </td>
                    ) : null}
                    <td className="right muted small">
                      {new Date(row.created_at).toLocaleDateString("en-NG")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="muted small legal">
          Read-only. Suspending, restricting and closing accounts arrive with the compliance
          tooling in phase 20 — each needs its own permission, a written reason and an audit row,
          which is more than a button on a list view.
        </p>
      </section>
    </>
  );
}
