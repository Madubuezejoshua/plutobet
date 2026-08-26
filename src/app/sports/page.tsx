import { listUpcoming } from "@/modules/odds/odds.service";
import { BetSlip } from "./bet-slip";

export const dynamic = "force-dynamic";

/**
 * Odds board.
 *
 * A server component reading straight from OddsService, which touches only
 * Postgres — so however many people are browsing, the upstream provider is
 * never called (the Phase 2 guarantee).
 *
 * The slip below is the only client component: prices and fixtures render on
 * the server, and just the interactive selection state ships to the browser.
 * That matters for the low-bandwidth Android target in §8 — a full client
 * render would ship the whole board twice, once as HTML and once as JSON.
 */
export default async function SportsPage() {
  const events = await listUpcoming({ sport: "football", limit: 40 });

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
        <h1>Football</h1>
        <p className="muted">
          {events.length === 0
            ? "No fixtures are loaded yet — the odds sync worker populates this board."
            : `${events.length} upcoming ${events.length === 1 ? "fixture" : "fixtures"}`}
        </p>
      </header>

      {events.length === 0 ? (
        <section className="card empty">
          <p>
            Nothing to show. Fixtures arrive from the odds provider on a schedule; if this is a
            fresh database, run the sync worker or seed a fixture first.
          </p>
        </section>
      ) : (
        <BetSlip events={events} />
      )}
    </main>
  );
}
