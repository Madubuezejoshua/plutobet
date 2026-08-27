import Link from "next/link";
import { jackpotService } from "@/modules/jackpot/jackpot.service";
import { naira } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jackpot" };

/**
 * Jackpot competitions.
 *
 * The pool shown is computed from real entries, not advertised. A jackpot that
 * displays a prize larger than the money actually collected and guaranteed is
 * making a promise it cannot keep, which is the specific dishonesty this
 * product invites.
 */
export default async function JackpotPage() {
  const competitions = await jackpotService.open().catch((error: unknown) => {
    console.error("[jackpot] unavailable", error);
    return [];
  });

  if (competitions.length === 0) {
    return (
      <>
        <header className="page-head">
          <h1>Jackpot</h1>
        </header>
        <section className="placeholder">
          <span className="ico" aria-hidden="true">🏆</span>
          <h2>No competition running</h2>
          <p>
            Predict a full slate of fixtures for a share of a pooled prize. Competitions are
            created by the operator with a fixed slate, entry price and prize structure.
          </p>
          <span className="phase-tag">No open competition right now</span>
          <p className="small muted">
            Entries, scoring and prize splitting are built and tested — including that the pool
            paid out equals the pool collected, to the kobo.
          </p>
          <div className="placeholder-actions">
            <Link href="/sports" className="btn primary">Sports</Link>
            <Link href="/" className="btn ghost">Home</Link>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <header className="page-head">
        <h1>Jackpot</h1>
        <p className="muted">{competitions.length} open</p>
      </header>

      <div className="stack">
        {competitions.map((competition) => (
          <section className="card" key={competition.id}>
            <div className="fixture-head">
              <span className="league">{competition.selectionCount} fixtures</span>
              <span>
                Closes {competition.closesAt.toLocaleString("en-NG", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <h2>{competition.name}</h2>

            <dl className="totals">
              <div>
                <dt>Entry</dt>
                <dd>{naira(competition.entryFeeMinor)}</dd>
              </div>
              <div className="payout">
                <dt>Prize pool</dt>
                <dd>{naira(competition.poolMinor)}</dd>
              </div>
              <div>
                <dt>Entries</dt>
                <dd>{competition.entries}</dd>
              </div>
            </dl>

            <p className="muted small">
              The pool grows as more people enter. The figure above is what has actually been
              collected and guaranteed so far — not a headline.
            </p>
          </section>
        ))}
      </div>

      <p className="muted small legal" style={{ marginBottom: 40 }}>
        Prizes are shared equally between everyone who scores the most correct predictions. If
        nobody reaches the advertised minimum, no prize is paid.
      </p>
    </>
  );
}
