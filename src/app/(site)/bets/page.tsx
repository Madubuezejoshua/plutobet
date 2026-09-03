import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";
import { Ticket } from "lucide-react";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { naira } from "@/lib/money";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "My bets" };

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
 *
 * "Returned" is what was actually paid, read from the bet row — never
 * recomputed here. A settled bet whose displayed return disagreed with the
 * ledger would be indistinguishable, to the customer, from being underpaid.
 *
 * There is no cash-out control on this page. The service exists but no
 * authenticated route does, so a button would be a promise nothing can keep.
 */
export default async function BetsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/signin?callbackUrl=%2Fbets");

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

  const open = rows.filter((bet) => bet.status === "PENDING").length;

  return (
    <PageShell
      title="My bets"
      sub={
        rows.length === 0
          ? "You have not placed a bet yet."
          : `${rows.length} most recent${open > 0 ? ` · ${open} still open` : ""}`
      }
    >
      {rows.length === 0 ? (
        <section className="sb-panel">
          <div className="sb-empty">
            <Ticket className="sb-empty__icon" size={28} aria-hidden="true" />
            <p className="sb-empty__title">No bets yet</p>
            <p className="sb-small">Your tickets appear here the moment one is accepted.</p>
            <p style={{ marginTop: "var(--sb-4)" }}>
              <Link href="/sports" className="sb-btn sb-btn--primary">Browse the odds</Link>
            </p>
          </div>
        </section>
      ) : (
        <section className="sb-panel">
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
              <article key={bet.id} className="sb-ticket">
                <div className="sb-ticket__head">
                  <span className={`sb-pill ${pillClass(bet.status)}`}>{label(bet.status)}</span>
                  <span className="sb-small sb-muted">
                    {bet.legs.length > 1 ? `${bet.legs.length}-fold` : "Single"}
                  </span>
                  <time
                    className="sb-small sb-muted"
                    dateTime={new Date(bet.placed_at).toISOString()}
                    style={{ marginLeft: "auto" }}
                  >
                    {new Date(bet.placed_at).toLocaleString("en-NG", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>

                <div>
                  {bet.legs.map((leg, index) => (
                    <div className="sb-ticket__leg" key={index}>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ display: "block" }}>{leg.selection}</strong>
                        <span className="sb-xs sb-muted">{leg.fixture}</span>
                      </div>
                      <span
                        className="sb-ticket__legodds"
                        style={{ color: leg.result === "LOST" ? "var(--sb-faint)" : undefined }}
                      >
                        {Number(leg.odds).toFixed(2)}
                      </span>
                      {leg.result && leg.result !== "PENDING" ? (
                        <span className={`sb-pill ${pillClass(leg.result)}`}>{label(leg.result)}</span>
                      ) : null}
                    </div>
                  ))}
                </div>

                <dl className="sb-ticket__foot">
                  <div>
                    <dt className="sb-xs sb-muted">Stake</dt>
                    <dd style={{ margin: 0, fontWeight: 700 }}>{naira(bet.stake_minor)}</dd>
                  </div>
                  <div>
                    <dt className="sb-xs sb-muted">Total odds</dt>
                    <dd style={{ margin: 0, fontWeight: 700 }}>
                      {Number(bet.total_odds_decimal).toFixed(2)}
                    </dd>
                  </div>
                  <div style={{ marginLeft: "auto", textAlign: "right" }}>
                    <dt className="sb-xs sb-muted">{settled ? "Returned" : "To return"}</dt>
                    <dd
                      style={{
                        margin: 0,
                        fontWeight: 800,
                        fontSize: "var(--sb-t-lg)",
                        color: paid && BigInt(paid) > 0n ? "var(--sb-up)" : undefined,
                      }}
                    >
                      {settled ? (paid ? naira(paid) : "—") : naira(bet.potential_return_minor)}
                    </dd>
                  </div>
                </dl>

                <p className="sb-ticket__ref">Reference {bet.id.slice(0, 8)}</p>
              </article>
            );
          })}
        </section>
      )}
    </PageShell>
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

/** Colour is a second signal only; the pill always carries its own word. */
function pillClass(status: string): string {
  if (status === "WON") return "sb-pill--won";
  if (status === "LOST") return "sb-pill--lost";
  if (status === "PENDING") return "sb-pill--open";
  if (status === "VOID") return "sb-pill--void";
  return "";
}
