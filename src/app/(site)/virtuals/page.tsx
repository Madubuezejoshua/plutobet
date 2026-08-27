import Link from "next/link";
import { virtualsService } from "@/modules/virtuals/virtuals.service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Virtuals" };

/**
 * Virtual sports.
 *
 * A virtual round is an ordinary sportsbook event on a synthetic timetable, so
 * prices, placement and settlement are the same machinery the real board uses.
 * Nothing is listed until a provider is publishing rounds — a schedule with no
 * fixtures is a dead end.
 */
export default async function VirtualsPage({
  searchParams,
}: {
  searchParams: Promise<{ discipline?: string }>;
}) {
  const params = await searchParams;
  const disciplines = await virtualsService.disciplines().catch(() => []);

  if (disciplines.length === 0) {
    return (
      <>
        <header className="page-head">
          <h1>Virtuals</h1>
        </header>
        <section className="placeholder">
          <span className="ico" aria-hidden="true">🎮</span>
          <h2>No rounds scheduled</h2>
          <p>
            Virtual fixtures come from a certified provider — we do not generate results
            ourselves, for the same reason we do not generate casino outcomes.
          </p>
          <span className="phase-tag">Awaiting a virtuals provider</span>
          <p className="small muted">
            Rounds are modelled as ordinary sportsbook events, so pricing, placement and
            settlement are already built and tested. Fixtures appear the moment a provider
            publishes a schedule.
          </p>
          <div className="placeholder-actions">
            <Link href="/sports" className="btn primary">Sports</Link>
            <Link href="/" className="btn ghost">Home</Link>
          </div>
        </section>
      </>
    );
  }

  const active = disciplines.find((d) => d.key === params.discipline) ?? disciplines[0]!;
  const [upcoming, results] = await Promise.all([
    virtualsService.upcoming(active.key).catch(() => []),
    virtualsService.recentResults(active.key).catch(() => []),
  ]);

  return (
    <>
      <header className="page-head">
        <h1>{active.name}</h1>
        <p className="muted">{upcoming.length} rounds scheduled</p>
      </header>

      <nav className="chip-row" aria-label="Virtual disciplines">
        {disciplines.map((discipline) => (
          <Link
            key={discipline.key}
            href={`/virtuals?discipline=${discipline.key}`}
            className="chip"
            aria-current={discipline.key === active.key ? "page" : undefined}
          >
            {discipline.name}
            <span className="chip-count">{discipline.upcoming}</span>
          </Link>
        ))}
      </nav>

      <section className="card">
        <h2>Next rounds</h2>
        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col">Fixture</th>
                <th scope="col" className="right">Starts</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((round) => (
                <tr key={round.id}>
                  <td className="muted small">#{round.roundNumber}</td>
                  <td>{round.fixture}</td>
                  <td className="right muted small">
                    {round.scheduledAt.toLocaleTimeString("en-NG", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {results.length > 0 ? (
        <section className="card">
          <h2>Recent results</h2>
          <div className="scroll-x">
            <table className="statement">
              <tbody>
                {results.map((result) => (
                  <tr key={`${result.roundNumber}-${result.settledAt.toISOString()}`}>
                    <td className="muted small">#{result.roundNumber}</td>
                    <td>{result.fixture}</td>
                    <td className="right muted small">
                      {result.settledAt.toLocaleTimeString("en-NG", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="muted small legal" style={{ marginBottom: 40 }}>
        Virtual results are generated and certified by the provider, not by PlutoBet. Bets settle
        through the same engine and ledger as real fixtures.
      </p>
    </>
  );
}
