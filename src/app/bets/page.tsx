import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";

export const dynamic = "force-dynamic";
export const metadata = { title: "My bets" };

function naira(minor: string): string {
  const value = BigInt(minor);
  const whole = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `₦${whole}.${(value % 100n).toString().padStart(2, "0")}`;
}

type BetRow = {
  id: string;
  status: string;
  stake_minor: string;
  total_odds_decimal: string;
  potential_return_minor: string;
  cashout_value_minor: string | null;
  placed_at: Date;
  settled_at: Date | null;
  legs: { fixture: string; selection: string; odds: string; result: string }[];
};

/**
 * Bet history.
 *
 * Shows the LOCKED odds on every leg, not the current price. That is what the
 * bet actually settles against, and showing today's price would quietly
 * misrepresent what the user is holding.
 */
export default async function BetsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/api/auth/signin");

  const rows = await db.execute<BetRow>(sql`
    SELECT
      b.id,
      b.status::text                    AS status,
      b.stake_minor::text               AS stake_minor,
      b.total_odds_decimal::text        AS total_odds_decimal,
      b.potential_return_minor::text    AS potential_return_minor,
      b.cashout_value_minor::text       AS cashout_value_minor,
      b.placed_at,
      b.settled_at,
      COALESCE(
        json_agg(
          json_build_object(
            'fixture',   e.home || ' v ' || e.away,
            'selection', s.label,
            'odds',      bl.locked_odds_decimal::text,
            'result',    bl.result::text
          ) ORDER BY bl.created_at
        ) FILTER (WHERE bl.id IS NOT NULL),
        '[]'
      ) AS legs
    FROM bets b
    LEFT JOIN bet_legs bl ON bl.bet_id = b.id
    LEFT JOIN selections s ON s.id = bl.selection_id
    LEFT JOIN markets m ON m.id = s.market_id
    LEFT JOIN events e ON e.id = m.event_id
    WHERE b.user_id = ${session.user.id}::uuid
    GROUP BY b.id
    ORDER BY b.placed_at DESC
    LIMIT 50
  `);

  return (
    <main className="shell">
      <nav className="nav" aria-label="Primary navigation">
        <div className="brand">Bet Platform</div>
        <div className="nav-links">
          <a href="/sports">Sports</a>
          <a href="/bets">My bets</a>
          <a href="/wallet">Wallet</a>
          <a href="/deposit">Deposit</a>
        </div>
      </nav>

      <header className="page-head">
        <h1>My bets</h1>
        <p className="muted">
          {rows.length === 0 ? "You have not placed a bet yet." : `${rows.length} most recent`}
        </p>
      </header>

      {rows.length === 0 ? (
        <section className="card empty">
          <p>
            Nothing here yet. <a href="/sports">Browse the odds</a> to place your first bet.
          </p>
        </section>
      ) : (
        <section className="bet-list">
          {rows.map((bet) => {
            const settled = bet.status !== "PENDING";
            const paid =
              bet.status === "CASHED_OUT" && bet.cashout_value_minor
                ? bet.cashout_value_minor
                : bet.status === "WON"
                  ? bet.potential_return_minor
                  : bet.status === "VOID"
                    ? bet.stake_minor
                    : null;

            return (
              <article key={bet.id} className="card bet">
                <div className="bet-head">
                  <span className={`pill ${statusClass(bet.status)}`}>{label(bet.status)}</span>
                  <time dateTime={new Date(bet.placed_at).toISOString()}>
                    {new Date(bet.placed_at).toLocaleString("en-NG", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>

                <ul className="bet-legs">
                  {bet.legs.map((leg, index) => (
                    <li key={index}>
                      <div>
                        <strong>{leg.selection}</strong>
                        <span className="muted small"> {leg.fixture}</span>
                      </div>
                      <span className={leg.result === "LOST" ? "muted" : ""}>
                        {Number(leg.odds).toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>

                <dl className="totals">
                  <div>
                    <dt>Stake</dt>
                    <dd>{naira(bet.stake_minor)}</dd>
                  </div>
                  <div>
                    <dt>{bet.legs.length > 1 ? `${bet.legs.length} legs` : "Odds"}</dt>
                    <dd>{Number(bet.total_odds_decimal).toFixed(2)}</dd>
                  </div>
                  <div>
                    <dt>{settled ? "Returned" : "To return"}</dt>
                    <dd className={paid && BigInt(paid) > 0n ? "credit" : undefined}>
                      {settled
                        ? paid
                          ? naira(paid)
                          : "—"
                        : naira(bet.potential_return_minor)}
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

function label(status: string): string {
  switch (status) {
    case "PENDING":
      return "Open";
    case "CASHED_OUT":
      return "Cashed out";
    case "VOID":
      return "Void";
    default:
      return status.charAt(0) + status.slice(1).toLowerCase();
  }
}

function statusClass(status: string): string {
  if (status === "WON") return "won";
  if (status === "LOST") return "critical";
  if (status === "PENDING") return "warning";
  return "";
}
