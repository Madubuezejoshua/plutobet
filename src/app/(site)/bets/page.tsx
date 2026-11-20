import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";
import { Ticket } from "lucide-react";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { PageShell } from "@/components/sportsbook/page-shell";
import { BetsList, type SerializedBetRow } from "./bets-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "My bets" };

type BetRow = {
  id: string;
  status: string;
  stake_minor: string;
  total_odds_decimal: string;
  potential_return_minor: string;
  cashout_value_minor: string | null;
  /** How much of the original stake has already been bought back. */
  cashed_out_stake_minor: string;
  placed_at: Date;
  settled_at: Date | null;
  legs: {
    fixture: string;
    selection: string;
    odds: string;
    result: string;
    selectionId?: string;
    eventId?: string;
    marketKey?: string;
    selectionKey?: string;
    currentPrice?: number | null;
    available?: boolean;
  }[];
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
 * Cash-out is offered on pending tickets only, and the price always comes from
 * the server. The component asks for an offer when the customer presses the
 * button rather than pricing every open ticket on page load: ten tickets would
 * otherwise mean ten pricing requests, most for offers nobody looks at.
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
      b.cashed_out_stake_minor::text    AS cashed_out_stake_minor,
      b.placed_at,
      b.settled_at,
      COALESCE(
        json_agg(
          json_build_object(
            'fixture',      e.home || ' v ' || e.away,
            'selection',    s.label,
            'odds',         bl.locked_odds_decimal::text,
            'result',       bl.result::text,
            'selectionId',  s.id,
            'eventId',      e.id,
            'marketKey',    m.key,
            'selectionKey', s.key,
            'currentPrice', s.current_price_decimal::float8,
            'available',    (m.status = 'OPEN' AND s.status = 'OPEN' AND e.status IN ('PENDING', 'LIVE') AND e.starts_at > now())
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

  const serialized: SerializedBetRow[] = rows.map((bet) => ({
    ...bet,
    placed_at: new Date(bet.placed_at).toISOString(),
    settled_at: bet.settled_at ? new Date(bet.settled_at).toISOString() : null,
  }));

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
        <BetsList bets={serialized} />
      )}
    </PageShell>
  );
}
