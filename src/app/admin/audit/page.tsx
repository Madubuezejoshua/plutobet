import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/pooled";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit Log" };

/**
 * The audit trail.
 *
 * Append-only at the database level, and every ADMIN row carries a mandatory
 * reason enforced by a CHECK constraint — an administrator cannot act without
 * saying why, and cannot later edit what they said.
 *
 * Read through the pooled client: this is reporting, not a money path.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string }>;
}) {
  try {
    await requirePermission("audit.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/api/auth/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Audit Log</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const params = await searchParams;
  const actorFilter = params.actor === "ADMIN" ? "ADMIN" : null;

  const rows = await db.execute<{
    id: string;
    actor_type: string;
    actor_email: string | null;
    action: string;
    entity: string;
    entity_id: string;
    reason: string | null;
    ip: string | null;
    created_at: Date;
  }>(sql`
    SELECT a.id, a.actor_type::text AS actor_type, u.email AS actor_email,
           a.action, a.entity, a.entity_id, a.reason, a.ip::text AS ip, a.created_at
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE ${actorFilter ? sql`a.actor_type = 'ADMIN'` : sql`TRUE`}
    ORDER BY a.created_at DESC
    LIMIT 200
  `);

  return (
    <>
      <header className="page-head">
        <h1>Audit Log</h1>
        <p className="muted">Most recent 200 entries. Append-only.</p>
      </header>

      <section className="card">
        <p className="muted small">
          <a href="/admin/audit">All</a> · <a href="/admin/audit?actor=ADMIN">Admin actions only</a>
        </p>

        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Entity</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Nothing recorded yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td className="muted small">
                      {new Date(row.created_at).toLocaleString("en-NG")}
                    </td>
                    <td>
                      <span className={row.actor_type === "ADMIN" ? "pill warning" : "pill"}>
                        {row.actor_type}
                      </span>
                      {row.actor_email ? (
                        <>
                          <br />
                          <span className="muted small">{row.actor_email}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <code>{row.action}</code>
                    </td>
                    <td className="muted small">
                      {row.entity}
                      <br />
                      <span className="muted">{row.entity_id.slice(0, 8)}…</span>
                    </td>
                    <td className="muted small">{row.reason ?? "—"}</td>
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
