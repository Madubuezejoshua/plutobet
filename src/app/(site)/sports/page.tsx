import Link from "next/link";
import { listUpcoming } from "@/modules/odds/odds.service";
import { listCompetitions, listSports } from "@/modules/sports/browse.service";
import { BetSlip } from "./bet-slip";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sports" };

/**
 * Odds board.
 *
 * A server component reading straight from OddsService, which touches only
 * Postgres — so however many people are browsing, the upstream provider is
 * never called (the Phase 2 guarantee).
 *
 * The slip below is the only client component: prices and fixtures render on
 * the server, and just the interactive selection state ships to the browser.
 * That matters for the low-bandwidth Android target — a full client render
 * would ship the whole board twice, once as HTML and once as JSON.
 */
export default async function SportsPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string; competition?: string }>;
}) {
  const params = await searchParams;
  const sportKey = params.sport ?? "football";

  const [sports, competitions] = await Promise.all([
    listSports().catch(() => []),
    listCompetitions(sportKey).catch(() => []),
  ]);

  const selectedCompetition = competitions.find((c) => c.key === params.competition);

  const events = await listUpcoming({
    sport: sportKey,
    competitionId: selectedCompetition?.id,
    limit: 60,
  });

  const activeSport = sports.find((s) => s.key === sportKey);

  return (
    <>
      <header className="page-head">
        <h1>{activeSport?.name ?? "Sports"}</h1>
        <p className="muted">
          {selectedCompetition
            ? `${selectedCompetition.name} · ${events.length} ${events.length === 1 ? "fixture" : "fixtures"}`
            : events.length === 0
              ? "No fixtures are loaded yet — the odds sync worker populates this board."
              : `${events.length} upcoming ${events.length === 1 ? "fixture" : "fixtures"}`}
        </p>
      </header>

      {/* Sports with something to bet on. Only one is active today, so this
          renders a single tab rather than a row of dead links. */}
      {sports.length > 1 ? (
        <nav className="chip-row" aria-label="Sports">
          {sports.map((sport) => (
            <Link
              key={sport.key}
              href={`/sports?sport=${sport.key}`}
              className="chip"
              aria-current={sport.key === sportKey ? "page" : undefined}
            >
              {sport.name}
              <span className="chip-count">{sport.fixtureCount}</span>
            </Link>
          ))}
        </nav>
      ) : null}

      {competitions.length > 0 ? (
        <nav className="chip-row" aria-label="Competitions">
          <Link
            href={`/sports?sport=${sportKey}`}
            className="chip"
            aria-current={selectedCompetition ? undefined : "page"}
          >
            All
          </Link>
          {competitions.map((competition) => (
            <Link
              key={competition.id}
              href={`/sports?sport=${sportKey}&competition=${competition.key}`}
              className="chip"
              aria-current={selectedCompetition?.id === competition.id ? "page" : undefined}
              title={competition.country ? `${competition.country} · ${competition.name}` : competition.name}
            >
              {competition.name}
              <span className="chip-count">{competition.fixtureCount}</span>
            </Link>
          ))}
        </nav>
      ) : null}

      {events.length === 0 ? (
        <section className="card empty">
          <p>
            {selectedCompetition
              ? "No fixtures are currently open in this competition."
              : "Nothing to show. Fixtures arrive from the odds provider on a schedule; if this is a fresh database, run the sync worker or seed a fixture first."}
          </p>
        </section>
      ) : (
        <BetSlip events={events} />
      )}
    </>
  );
}
