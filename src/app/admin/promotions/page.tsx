import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { naira } from "@/lib/money";
import { guardAdminPage } from "../_guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Promotions" };

/**
 * Promotions and the bonus liability they create.
 *
 * Outstanding is shown next to granted because they answer different
 * questions. Granted is what marketing has spent; outstanding is what the
 * business still owes if every wagering requirement completes — and only the
 * second belongs anywhere near a balance sheet.
 */
export default async function AdminPromotionsPage() {
  const guard = await guardAdminPage("promotions.read", "Promotions");
  if (!guard.ok) return guard.denied;

  const promos = await db.execute<{
    id: string;
    code: string;
    name: string;
    kind: string;
    claims: number;
    granted_minor: string;
  }>(sql`
    SELECT p.id::text, p.code, p.name, p.kind::text,
           count(DISTINCT c.id)::int AS claims,
           COALESCE(sum(b.granted_minor), 0)::text AS granted_minor
    FROM promotions p
    LEFT JOIN promotion_claims c ON c.promotion_id = p.id
    LEFT JOIN bonuses b ON b.promotion_id = p.id
    GROUP BY p.id
    ORDER BY 5 DESC
  `);

  const [bonus] = await db.execute<{
    active: number;
    granted: string;
    outstanding: string;
    wagered: string;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
      COALESCE(sum(granted_minor), 0)::text AS granted,
      COALESCE(sum(granted_minor) FILTER (WHERE status = 'ACTIVE'), 0)::text AS outstanding,
      COALESCE(sum(wagered_minor), 0)::text AS wagered
    FROM bonuses
  `);

  return (
    <>
      <header className="page-head">
        <h1>Promotions</h1>
        <p className="muted">
          Bonus credit sits in its own wallet bucket and cannot be withdrawn — a database
          trigger refuses it, not a service check.
        </p>
      </header>

      <section className="tiles">
        <div className="tile">
          <span className="tile-label">Active bonuses</span>
          <span className="tile-value">{bonus?.active ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Granted, all time</span>
          <span className="tile-value">{naira(BigInt(bonus?.granted ?? "0"))}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Outstanding liability</span>
          <span className="tile-value">{naira(BigInt(bonus?.outstanding ?? "0"))}</span>
          <span className="muted">owed if wagering completes</span>
        </div>
        <div className="tile">
          <span className="tile-label">Wagered against bonuses</span>
          <span className="tile-value">{naira(BigInt(bonus?.wagered ?? "0"))}</span>
        </div>
      </section>

      {promos.length === 0 ? (
        <p className="notice">No promotions created yet.</p>
      ) : (
        <table className="statement">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Kind</th>
              <th className="right">Claims</th>
              <th className="right">Granted</th>
            </tr>
          </thead>
          <tbody>
            {promos.map((promo) => (
              <tr key={promo.id}>
                <td><code>{promo.code}</code></td>
                <td>{promo.name}</td>
                <td className="muted">{promo.kind.toLowerCase().replace(/_/g, " ")}</td>
                <td className="right">{promo.claims}</td>
                <td className="right">{naira(BigInt(promo.granted_minor))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
