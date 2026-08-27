import { liveSnapshot, type LiveSnapshot } from "@/modules/odds/live-feed";
import { recentResults } from "@/modules/sports/results.service";
import { LiveScoreBoard } from "./livescore-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "Livescore" };

/**
 * Scores without prices.
 *
 * Deliberately shows no odds and offers no bet. Someone checking a score
 * should be able to do that without being sold to, and the master spec calls
 * this out as a product in its own right rather than a corner of the odds
 * board.
 */
export default async function LivescorePage() {
  const [snapshot, finished] = await Promise.all([
    liveSnapshot("football").catch((error: unknown) => {
      console.error("[livescore] snapshot unavailable", error);
      return { version: "0-0", events: [] } as LiveSnapshot;
    }),
    // Today's completed matches, so the page is useful even when nothing is
    // currently in play.
    recentResults({ since: startOfToday(), limit: 40 }).catch(() => []),
  ]);

  return (
    <>
      <header className="page-head">
        <h1>Livescore</h1>
        <p className="muted">Scores and kick-off times. No bet required.</p>
      </header>

      <LiveScoreBoard snapshot={snapshot} />

      {finished.length > 0 ? (
        <section className="card">
          <h2>Finished today</h2>
          <div className="scroll-x">
            <table className="statement">
              <tbody>
                {finished.map((result) => (
                  <tr key={result.eventId}>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
