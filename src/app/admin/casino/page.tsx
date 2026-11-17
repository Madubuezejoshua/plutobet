import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { naira } from "@/lib/money";
import { guardAdminPage } from "../_guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Casino" };

/**
 * Casino providers, catalogue and round history.
 *
 * The catalogue is almost certainly empty, and the page says so rather than
 * rendering placeholder tiles: no aggregator contract is signed, so there are
 * no real games to list. An admin screen that invents a lobby is how a
 * business ends up believing it has a product it has not bought.
 *
 * The round table is live regardless, because the callback handler and ledger
 * integration are built and tested — the moment a provider is connected,
 * rounds appear here with no further work.
 */
export default async function AdminCasinoPage() {
  const guard = await guardAdminPage("casino.read", "Casino");
  if (!guard.ok) return guard.denied;

  const [catalogue] = await db.execute<{
    providers: number;
    games: number;
    live_providers: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM casino_providers) AS providers,
      (SELECT count(*)::int FROM casino_games) AS games,
      (SELECT count(*)::int FROM casino_providers WHERE active) AS live_providers
  `);

  const [rounds] = await db.execute<{
    total: number;
    staked: string;
    paid: string;
  }>(sql`
    SELECT
      count(*)::int AS total,
      COALESCE(sum(stake_minor), 0)::text AS staked,
      COALESCE(sum(payout_minor), 0)::text AS paid
    FROM game_rounds
  `);

  const recent = await db.execute<{
    id: string;
    email: string;
    provider: string;
    game: string;
    stake_minor: string;
    payout_minor: string;
    status: string;
    created_at: Date;
  }>(sql`
    SELECT r.id::text, u.email, r.provider, r.game,
           r.stake_minor::text, r.payout_minor::text, r.status::text, r.created_at
    FROM game_rounds r
    JOIN users u ON u.id = r.user_id
    ORDER BY r.created_at DESC
    LIMIT 100
  `);

  const staked = BigInt(rounds?.staked ?? "0");
  const paid = BigInt(rounds?.paid ?? "0");

  return (
    <>
      <header className="page-head">
        <h1>Casino</h1>
        <p className="muted">
          {catalogue?.providers ?? 0} providers configured · {catalogue?.games ?? 0} games
        </p>
      </header>

      {Number(catalogue?.live_providers ?? 0) === 0 ? (
        <p className="notice">
          <strong>No casino aggregator is connected.</strong> The provider interface,
          callback handling and ledger integration are built and tested — this needs a
          commercial contract, not code. Rounds will appear below as soon as one is live.
        </p>
      ) : null}

      <section className="tiles">
        <div className="tile">
          <span className="tile-label">Rounds played</span>
          <span className="tile-value">{rounds?.total ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Staked</span>
          <span className="tile-value">{naira(staked)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Paid out</span>
          <span className="tile-value">{naira(paid)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Gross gaming revenue</span>
          <span className="tile-value">{naira(staked - paid)}</span>
          <span className="muted">stakes less payouts</span>
        </div>
      </section>

      {recent.length === 0 ? (
        <p className="muted">No rounds have been played.</p>
      ) : (
        <div className="table-scroll">
          <table className="statement">
            <thead>
              <tr>
                <th>When</th>
                <th>Customer</th>
                <th>Game</th>
                <th className="right">Stake</th>
                <th className="right">Payout</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((round) => (
                <tr key={round.id}>
                  <td className="muted">{new Date(round.created_at).toLocaleString()}</td>
                  <td>{round.email}</td>
                  <td>
                    {round.game}
                    <span className="muted"> · {round.provider}</span>
                  </td>
                  <td className="right">{naira(BigInt(round.stake_minor))}</td>
                  <td className="right">{naira(BigInt(round.payout_minor))}</td>
                  <td className="muted">{round.status.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
