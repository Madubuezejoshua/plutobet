import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { listUpcoming, type EventView } from "@/modules/odds/odds.service";
import { NAV_ITEMS, UTILITY_ROUTES } from "@/lib/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "PlutoBet — Sports betting, casino and games" };

/**
 * Homepage.
 *
 * Everything on this page is either real or explicitly labelled as not yet
 * built. There are no mock fixtures, no placeholder game tiles dressed up as
 * a lobby, and no counters showing invented numbers — the build rules forbid
 * all three, and on a betting site a fabricated fixture is a fabricated price.
 *
 * Featured matches and popular leagues are derived from the same fixtures the
 * odds board reads. When the sync worker has not run, the section says so
 * rather than filling itself with something plausible.
 */
export default async function HomePage() {
  const [session, fixtures] = await Promise.all([
    getServerSession(authOptions),
    listUpcoming({ sport: "football", limit: 24 }).catch((error: unknown) => {
      // A homepage that 500s because the odds table is unreachable is worse
      // than one that renders with an empty board and says so.
      console.error("[home] fixtures unavailable", error);
      return [] as EventView[];
    }),
  ]);

  const signedIn = Boolean(session?.user);
  const featured = fixtures.slice(0, 6);
  const leagues = topLeagues(fixtures);

  return (
    <>
      {/* ---------------------------------------------------------- banner */}
      <section className="hero">
        <span className="eyebrow">
          {signedIn ? "Welcome back" : "Nigeria · Licensed operator"}
        </span>
        <h1>Bet on football. Get the reasoning too.</h1>
        <p>
          Real odds, an auditable wallet, and — when Pluto AI lands — an assistant that can find
          a fixture, explain a market and build a slip with you before you confirm it.
        </p>
        <div className="hero-actions">
          <Link href="/sports" className="btn primary">
            View today&rsquo;s odds
          </Link>
          {signedIn ? (
            <Link href={UTILITY_ROUTES.deposit} className="btn ghost">
              Deposit
            </Link>
          ) : (
            <Link href={UTILITY_ROUTES.register} className="btn ghost">
              Create an account
            </Link>
          )}
        </div>
      </section>

      {/* --------------------------------------------------------- products */}
      <section className="section">
        <div className="section-head">
          <h2>Products</h2>
        </div>
        <div className="tile-row">
          {NAV_ITEMS.filter((item) => item.key !== "home" && !item.requiresAuth).map((item) => (
            <Link key={item.key} href={item.href} className="tile">
              <span className="ico" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
              {item.status === "PLANNED" ? <span className="soon">Soon</span> : null}
            </Link>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------- featured matches */}
      <section className="section">
        <div className="section-head">
          <h2>Featured matches</h2>
          <Link href="/sports">All fixtures →</Link>
        </div>

        {featured.length === 0 ? (
          <div className="card">
            <p className="muted small" style={{ margin: 0 }}>
              No fixtures are loaded. Prices arrive from the odds provider on a schedule — if
              this is a fresh database, the sync worker has not run yet. Nothing is being
              invented to fill the gap.
            </p>
          </div>
        ) : (
          <div className="rail">
            {featured.map((event) => (
              <FixtureCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </section>

      {/* --------------------------------------------------- popular leagues */}
      {leagues.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2>Popular leagues</h2>
          </div>
          <div className="tile-row">
            {leagues.map((league) => (
              <Link key={league.name} href="/sports" className="tile">
                <span className="ico" aria-hidden="true">
                  🏆
                </span>
                {league.name}
                <span className="muted small" style={{ fontWeight: 500 }}>
                  {league.count} {league.count === 1 ? "match" : "matches"}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* ---------------------------------------------------------- in play */}
      <section className="section">
        <div className="section-head">
          <h2>Live now</h2>
        </div>
        <div className="card">
          <p className="muted small" style={{ margin: 0 }}>
            <span className="pill warning">Phase 9</span>{" "}
            In-play betting needs a live data feed and a realtime connection, neither of which is
            connected yet. Rather than show a frozen scoreboard that looks live, this stays empty
            until it is real.
          </p>
        </div>
      </section>

      {/* --------------------------------------------------------- shortcuts */}
      {signedIn ? (
        <section className="section">
          <div className="section-head">
            <h2>Your account</h2>
          </div>
          <div className="tile-row">
            <Link href="/bets" className="tile">
              <span className="ico" aria-hidden="true">🎫</span>
              My Bets
            </Link>
            <Link href="/wallet" className="tile">
              <span className="ico" aria-hidden="true">👛</span>
              Wallet
            </Link>
            <Link href={UTILITY_ROUTES.deposit} className="tile">
              <span className="ico" aria-hidden="true">➕</span>
              Deposit
            </Link>
            <Link href={UTILITY_ROUTES.verify} className="tile">
              <span className="ico" aria-hidden="true">🪪</span>
              Verify
            </Link>
            <Link href={UTILITY_ROUTES.responsible} className="tile">
              <span className="ico" aria-hidden="true">🛡️</span>
              Limits
            </Link>
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * One fixture with its 1X2 prices.
 *
 * Read-only: tapping goes to the odds board rather than adding a selection
 * here. The slip lives on `/sports`, and a second, subtly different selection
 * path is how two surfaces end up disagreeing about what a user picked.
 */
function FixtureCard({ event }: { event: EventView }) {
  const oneXTwo = event.markets.find((market) => market.key === "1x2");
  const kickoff = new Date(event.startsAt);

  return (
    <Link href="/sports" className="card" style={{ textDecoration: "none", display: "block" }}>
      <div className="fixture-head">
        <span className="league">{event.league}</span>
        <span>
          {kickoff.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <div className="teams">
        {event.home}
        <br />
        {event.away}
      </div>

      {oneXTwo ? (
        <div className="odds-row">
          {oneXTwo.selections.slice(0, 3).map((selection) => (
            <span key={selection.id} className="odd" role="presentation">
              <span className="odd-label">{selection.label}</span>
              <span className="odd-price">{selection.price.toFixed(2)}</span>
            </span>
          ))}
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          Match odds not currently open.
        </p>
      )}
    </Link>
  );
}

/** The five leagues with the most fixtures loaded. Derived, never hard-coded. */
function topLeagues(fixtures: EventView[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const fixture of fixtures) {
    counts.set(fixture.league, (counts.get(fixture.league) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}
