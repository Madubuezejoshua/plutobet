import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { naira } from "@/lib/money";
import { guardAdminPage } from "../_guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bets" };

/**
 * Every bet on the platform.
 *
 * Read-only. Settling or voiding a bet happens through the settlement
 * pipeline, never from a table row — a one-click settle on a list like this is
 * how a mis-click becomes a payout.
 *
 * Legs are aggregated in SQL rather than fetched per row. At a few hundred
 * bets a query-per-row is merely slow; on a busy Saturday it is an outage.
 */

const STATUS_PILL: Record<string, string> = {
  WON: "pill ok",
  LOST: "pill",
  VOID: "pill warning",
  PENDING: "pill warning",
  CASHED_OUT: "pill ok",
  PARTIALLY_CASHED_OUT: "pill warning",
};

/**
 * The shape of a bet, derived rather than stored.
 *
 * There is no bet_type column: a bet IS its legs. One leg is a single, more
 * than one is an accumulator, and a combination_index means this row is one
 * combination of a system bet placed as a slip.
 */
function betType(bet: BetRow): string {
  if (bet.combination_index !== null) return `system #${bet.combination_index}`;
  return bet.leg_count > 1 ? `acca (${bet.leg_count})` : "single";
}

type BetRow = {
  id: string;
  email: string;
  user_id: string;
  stake_minor: string;
  potential_return_minor: string;
  status: string;
  slip_id: string | null;
  combination_index: number | null;
  leg_count: number;
  won_legs: number;
  lost_legs: number;
  pending_legs: number;
  cashed_out_stake_minor: string;
  placed_at: Date;
  settled_at: Date | null;
}

export default async function AdminBetsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const guard = await guardAdminPage("bets.read", "Bets");
  if (!guard.ok) return guard.denied;

  const { status } = await searchParams;
  const filter = status?.toUpperCase();
  const valid = filter && Object.keys(STATUS_PILL).includes(filter) ? filter : null;

  const rows = await db.execute<BetRow>(sql`
    SELECT
      b.id::text,
      u.email,
      b.user_id::text,
      b.stake_minor::text,
      b.potential_return_minor::text,
      b.status::text,
      b.slip_id::text,
      b.combination_index,
      b.cashed_out_stake_minor::text,
      b.placed_at,
      b.settled_at,
      count(l.id)::int AS leg_count,
      count(l.id) FILTER (WHERE l.result = 'WON')::int AS won_legs,
      count(l.id) FILTER (WHERE l.result = 'LOST')::int AS lost_legs,
      count(l.id) FILTER (WHERE l.result = 'PENDING')::int AS pending_legs
    FROM bets b
    JOIN users u ON u.id = b.user_id
    LEFT JOIN bet_legs l ON l.bet_id = b.id
    ${valid ? sql`WHERE b.status = ${valid}::bet_status` : sql``}
    GROUP BY b.id, u.email
    ORDER BY b.placed_at DESC
    LIMIT 200
  `);

  const [totals] = await db.execute<{
    total: number;
    pending: number;
    staked: string;
    liability: string;
  }>(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      COALESCE(sum(stake_minor), 0)::text AS staked,
      -- Open liability: what the book owes if every pending bet wins. The
      -- number that matters when deciding whether to accept more action.
      COALESCE(sum(potential_return_minor) FILTER (WHERE status = 'PENDING'), 0)::text AS liability
    FROM bets
  `);

  return (
    <>
      <header className="page-head">
        <h1>Bets</h1>
        <p className="muted">
          {totals?.total ?? 0} placed · {totals?.pending ?? 0} pending ·{" "}
          {naira(BigInt(totals?.staked ?? "0"))} staked · open liability{" "}
          <strong>{naira(BigInt(totals?.liability ?? "0"))}</strong>
        </p>
      </header>

      <nav className="filters">
        <Link href="/admin/bets" className={valid ? "btn sm" : "btn sm primary"}>
          All
        </Link>
        {Object.keys(STATUS_PILL).map((key) => (
          <Link
            key={key}
            href={`/admin/bets?status=${key}`}
            className={valid === key ? "btn sm primary" : "btn sm"}
          >
            {key.replace(/_/g, " ").toLowerCase()}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="notice">No bets{valid ? ` with status ${valid.toLowerCase()}` : ""} yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="statement">
            <thead>
              <tr>
                <th>Placed</th>
                <th>Customer</th>
                <th>Type</th>
                <th>Legs</th>
                <th className="right">Stake</th>
                <th className="right">To return</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((bet) => {
                const cashedOut = BigInt(bet.cashed_out_stake_minor) > 0n;
                return (
                  <tr key={bet.id}>
                    <td className="muted">{new Date(bet.placed_at).toLocaleString()}</td>
                    <td>
                      <Link href={`/admin/users?q=${encodeURIComponent(bet.email)}`}>
                        {bet.email}
                      </Link>
                    </td>
                    <td className="muted">{betType(bet)}</td>
                    <td className="muted">
                      {bet.leg_count}
                      {bet.pending_legs > 0 ? (
                        <span className="muted"> ({bet.pending_legs} open)</span>
                      ) : (
                        <span className="muted">
                          {" "}
                          ({bet.won_legs}W/{bet.lost_legs}L)
                        </span>
                      )}
                    </td>
                    <td className="right">{naira(BigInt(bet.stake_minor))}</td>
                    <td className="right">{naira(BigInt(bet.potential_return_minor))}</td>
                    <td>
                      <span className={STATUS_PILL[bet.status] ?? "pill"}>
                        {bet.status.replace(/_/g, " ").toLowerCase()}
                      </span>
                      {/* Surfaced because a cashed-out bet settles for less
                          than its stake suggests, and a reviewer comparing
                          stake to payout would otherwise read it as a loss. */}
                      {cashedOut ? <span className="pill"> cashed out</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 200 ? (
        <p className="muted">Showing the 200 most recent. Use a status filter to narrow.</p>
      ) : null}
    </>
  );
}
