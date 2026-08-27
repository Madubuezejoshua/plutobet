import Link from "next/link";
import { recentResults } from "@/modules/sports/results.service";
import { listCompetitions } from "@/modules/sports/browse.service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Results" };

/**
 * Completed fixtures.
 *
 * Read-only and open to everyone — this is the part of the product people use
 * without betting, and requiring an account to check a score would be a
 * pointless barrier.
 *
 * Scores come from `periods.ft`, the same regulation figure settlement pays
 * against. A results page that contradicted the settlement would be a support
 * ticket per fixture.
 */
export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ competition?: string }>;
}) {
  const params = await searchParams;

  const competitions = await listCompetitions("football").catch(() => []);
  const selected = competitions.find((c) => c.key === params.competition);

  const results = await recentResults({
    competitionId: selected?.id,
    limit: 100,
  }).catch((error: unknown) => {
    console.error("[results] unavailable", error);
    return [];
  });

  return (
    <>
      <header className="page-head">
        <h1>Results</h1>
        <p className="muted">
          {selected ? selected.name : "All competitions"} · {results.length} fixtures
        </p>
      </header>

      {competitions.length > 0 ? (
        <nav className="chip-row" aria-label="Competitions">
          <Link href="/results" className="chip" aria-current={selected ? undefined : "page"}>
            All
          </Link>
          {competitions.map((competition) => (
            <Link
              key={competition.id}
              href={`/results?competition=${competition.key}`}
              className="chip"
              aria-current={selected?.id === competition.id ? "page" : undefined}
            >
              {competition.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {results.length === 0 ? (
        <section className="card empty">
          <p>
            No settled fixtures yet. Results appear here once matches finish and the settlement
            worker has ingested them.
          </p>
        </section>
      ) : (
        <section className="card">
          <div className="scroll-x">
            <table className="statement">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Competition</th>
                  <th scope="col">Fixture</th>
                  <th scope="col" className="right">Score</th>
                  <th scope="col" className="right">HT</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.eventId}>
                    <td className="muted small">
                      {result.playedAt.toLocaleDateString("en-NG", {
                        day: "2-digit",
                        month: "short",
                      })}
                    </td>
                    <td className="muted small">{result.competition ?? "—"}</td>
                    <td>
                      {result.homeName} v {result.awayName}
                    </td>
                    <td className="right">
                      {result.homeScore === null || result.awayScore === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <strong>
                          {result.homeScore} - {result.awayScore}
                        </strong>
                      )}
                    </td>
                    <td className="right muted small">
                      {result.halfTimeHome === null || result.halfTimeAway === null
                        ? "—"
                        : `${result.halfTimeHome} - ${result.halfTimeAway}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted small legal">
            Scores shown are the regulation result — the same figure bets settle against. A match
            decided on penalties is a draw here, because that is what it is for betting.
          </p>
        </section>
      )}
    </>
  );
}
