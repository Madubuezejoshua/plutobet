import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { naira } from "@/lib/money";
import { guardAdminPage } from "../_guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Responsible Gaming" };

/**
 * Player-protection controls, as they actually stand.
 *
 * Self-exclusions are shown as COUNTS and expiry dates only, never with the
 * customer attached. The exclusion is keyed to an HMAC digest of BVN/NIN under
 * a server-held pepper — deliberately, so it survives someone re-registering
 * with a new email — and joining it back to an identity here would undo the
 * one property that makes it work.
 *
 * There are no actions on this page. Lifting an exclusion early is not an
 * administrative convenience; it is the thing the mechanism exists to prevent.
 */
export default async function AdminResponsiblePage() {
  const guard = await guardAdminPage("compliance.read", "Responsible Gaming");
  if (!guard.ok) return guard.denied;

  const [exclusions] = await db.execute<{
    active: number;
    expired: number;
    permanent: number;
    next_expiry: Date | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE until IS NULL OR until > now())::int AS active,
      count(*) FILTER (WHERE until IS NOT NULL AND until <= now())::int AS expired,
      count(*) FILTER (WHERE until IS NULL)::int AS permanent,
      min(until) FILTER (WHERE until > now()) AS next_expiry
    FROM self_exclusions
  `);

  const limits = await db.execute<{
    type: string;
    n: number;
    total_minor: string;
    median_minor: string;
  }>(sql`
    SELECT
      type::text,
      count(*)::int AS n,
      COALESCE(sum(amount_minor), 0)::text AS total_minor,
      COALESCE(
        percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_minor)::bigint, 0
      )::text AS median_minor
    FROM rg_limits
    GROUP BY type
    ORDER BY 2 DESC
  `);

  const [coverage] = await db.execute<{ users: number; with_limits: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(DISTINCT user_id)::int FROM rg_limits) AS with_limits
  `);

  const pct =
    coverage && coverage.users > 0
      ? Math.round((coverage.with_limits / coverage.users) * 100)
      : 0;

  return (
    <>
      <header className="page-head">
        <h1>Responsible Gaming</h1>
        <p className="muted">
          Limits are asymmetric by design: lowering one applies immediately, raising one
          waits 24 hours.
        </p>
      </header>

      <section className="tiles">
        <div className="tile">
          <span className="tile-label">Active self-exclusions</span>
          <span className="tile-value">{exclusions?.active ?? 0}</span>
          <span className="muted">{exclusions?.permanent ?? 0} permanent</span>
        </div>
        <div className="tile">
          <span className="tile-label">Expired exclusions</span>
          <span className="tile-value">{exclusions?.expired ?? 0}</span>
          <span className="muted">these accounts may play again</span>
        </div>
        <div className="tile">
          <span className="tile-label">Customers with a limit set</span>
          <span className="tile-value">{coverage?.with_limits ?? 0}</span>
          <span className="muted">{pct}% of all accounts</span>
        </div>
      </section>

      {exclusions?.next_expiry ? (
        <p className="muted">
          Next exclusion expires {new Date(exclusions.next_expiry).toLocaleDateString()}.
        </p>
      ) : null}

      <section>
        <h2>Limits in force</h2>
        {limits.length === 0 ? (
          <p className="notice">
            No customer has set a limit yet. That is expected on a new platform, but the
            figure is worth watching — it is the clearest signal of whether the tools are
            discoverable.
          </p>
        ) : (
          <table className="statement">
            <thead>
              <tr>
                <th>Limit</th>
                <th className="right">Customers</th>
                <th className="right">Median</th>
                <th className="right">Combined</th>
              </tr>
            </thead>
            <tbody>
              {limits.map((limit) => (
                <tr key={limit.type}>
                  <td>{limit.type.toLowerCase().replace(/_/g, " ")}</td>
                  <td className="right">{limit.n}</td>
                  <td className="right">{naira(BigInt(limit.median_minor))}</td>
                  <td className="right">{naira(BigInt(limit.total_minor))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="notice" style={{ marginTop: "1.5rem" }}>
        Self-excluded customers are not listed by name. The exclusion is keyed to a hashed
        identity document rather than an email so it survives re-registration; attaching a
        customer to it here would defeat that.
      </p>
    </>
  );
}
