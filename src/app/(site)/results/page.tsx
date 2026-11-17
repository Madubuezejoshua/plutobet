import Link from "next/link";
import { recentResults } from "@/modules/sports/results.service";
import { listCompetitions } from "@/modules/sports/browse.service";
import { PageShell } from "@/components/sportsbook/page-shell";

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
    <PageShell
      title="Results"
      sub={`${selected ? selected.name : "All competitions"} · ${results.length} fixtures`}
    >
      {competitions.length > 0 ? (
        <div className="sb-panel" style={{ marginBottom: "var(--sb-3)" }}>
          <nav className="sb-chips" aria-label="Competitions">
            <Link href="/results" className="sb-chip" aria-current={selected ? undefined : "true"}>
              All
            </Link>
            {competitions.map((competition) => (
              <Link
                key={competition.id}
                href={`/results?competition=${competition.key}`}
                className="sb-chip"
                aria-current={selected?.id === competition.id ? "true" : undefined}
              >
                {competition.name}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}

      {results.length === 0 ? (
        <section className="sb-panel">
          <div className="sb-empty">
            <p className="sb-empty__title">No settled fixtures yet</p>
            <p className="sb-small">
              Results appear here once matches finish and the settlement worker has ingested them.
            </p>
          </div>
        </section>
      ) : (
        <section className="sb-panel">
          <div className="sb-tablewrap">
            <table className="sb-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Competition</th>
                  <th scope="col">Fixture</th>
                  <th scope="col" className="sb-table__num">Score</th>
                  <th scope="col" className="sb-table__num">HT</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.eventId}>
                    <td className="sb-small sb-muted">
                      {result.playedAt.toLocaleDateString("en-NG", {
                        day: "2-digit",
                        month: "short",
                      })}
                    </td>
                    <td className="sb-small sb-muted">{result.competition ?? "—"}</td>
                    <td>
                      {result.homeName} v {result.awayName}
                    </td>
                    <td className="sb-table__num">
                      {result.homeScore === null || result.awayScore === null ? (
                        <span className="sb-muted">—</span>
                      ) : (
                        <strong>
                          {result.homeScore} - {result.awayScore}
                        </strong>
                      )}
                    </td>
                    <td className="sb-table__num sb-muted sb-small">
                      {result.halfTimeHome === null || result.halfTimeAway === null
                        ? "—"
                        : `${result.halfTimeHome} - ${result.halfTimeAway}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sb-xs sb-muted" style={{ padding: "var(--sb-3)", margin: 0 }}>
            Scores shown are the regulation result — the same figure bets settle against. A match
            decided on penalties is a draw here, because that is what it is for betting.
          </p>
        </section>
      )}
    </PageShell>
  );
}
