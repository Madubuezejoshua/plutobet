import Link from "next/link";
import { virtualsService } from "@/modules/virtuals/virtuals.service";
import { Gamepad2 } from "lucide-react";
import { PageShell } from "@/components/sportsbook/page-shell";

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
      <PageShell title="Virtuals" width="narrow">
        <section className="sb-panel" style={{ textAlign: "center", padding: "var(--sb-8) var(--sb-4)" }}>
          <Gamepad2 size={30} aria-hidden="true" style={{ color: "var(--sb-faint)" }} />
          <h2 style={{ margin: "var(--sb-3) 0 4px", fontSize: 19 }}>No rounds scheduled</h2>
          <p className="sb-muted" style={{ margin: 0 }}>
            Virtual fixtures come from a certified provider — we do not generate results
            ourselves, for the same reason we do not generate casino outcomes.
          </p>
          <p className="sb-note sb-note--warn" style={{ display: "inline-flex", margin: "var(--sb-4) 0 0" }}>
            Awaiting a virtuals provider
          </p>
          <p className="sb-small sb-muted" style={{ maxWidth: 460, margin: "var(--sb-3) auto 0" }}>
            Rounds are modelled as ordinary sportsbook events, so pricing, placement and
            settlement are already built and tested. Fixtures appear the moment a provider
            publishes a schedule.
          </p>
          <div style={{ display: "flex", gap: "var(--sb-2)", justifyContent: "center", marginTop: "var(--sb-5)" }}>
            <Link href="/sports" className="sb-btn sb-btn--primary">Sports</Link>
            <Link href="/" className="sb-btn sb-btn--ghost">Home</Link>
          </div>
        </section>
      </PageShell>
    );
  }

  const active = disciplines.find((d) => d.key === params.discipline) ?? disciplines[0]!;
  const [upcoming, results] = await Promise.all([
    virtualsService.upcoming(active.key).catch(() => []),
    virtualsService.recentResults(active.key).catch(() => []),
  ]);

  return (
    <PageShell title={active.name} sub={`${upcoming.length} rounds scheduled`}>
      <div className="sb-panel" style={{ marginBottom: "var(--sb-3)" }}>
        <nav className="sb-chips" aria-label="Virtual disciplines">
          {disciplines.map((discipline) => (
            <Link
              key={discipline.key}
              href={`/virtuals?discipline=${discipline.key}`}
              className="sb-chip"
              aria-current={discipline.key === active.key ? "true" : undefined}
            >
              {discipline.name}
              <span className="sb-railitem__count">{discipline.upcoming}</span>
            </Link>
          ))}
        </nav>
      </div>

      <section className="sb-panel">
        <div className="sb-panel__head"><h2 className="sb-panel__title">Next rounds</h2></div>
        <div className="sb-tablewrap">
          <table className="sb-table">
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col">Fixture</th>
                <th scope="col" className="sb-table__num">Starts</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((round) => (
                <tr key={round.id}>
                  <td className="sb-muted sb-small">#{round.roundNumber}</td>
                  <td>{round.fixture}</td>
                  <td className="sb-table__num sb-muted sb-small">
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
        <section className="sb-panel" style={{ marginTop: "var(--sb-3)" }}>
          <div className="sb-panel__head"><h2 className="sb-panel__title">Recent results</h2></div>
          <div className="sb-tablewrap">
            <table className="sb-table">
              <tbody>
                {results.map((result) => (
                  <tr key={`${result.roundNumber}-${result.settledAt.toISOString()}`}>
                    <td className="sb-muted sb-small">#{result.roundNumber}</td>
                    <td>{result.fixture}</td>
                    <td className="sb-table__num sb-muted sb-small">
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

      <p className="sb-xs sb-muted" style={{ marginTop: "var(--sb-4)" }}>
        Virtual results are generated and certified by the provider, not by PlutoBet. Bets settle
        through the same engine and ledger as real fixtures.
      </p>
    </PageShell>
  );
}
