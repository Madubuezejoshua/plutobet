import Link from "next/link";
import { jackpotService } from "@/modules/jackpot/jackpot.service";
import { naira } from "@/lib/money";
import { Trophy } from "lucide-react";
import { PageShell } from "@/components/sportsbook/page-shell";

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
      <PageShell title="Jackpot" width="narrow">
        <section className="sb-panel" style={{ textAlign: "center", padding: "var(--sb-8) var(--sb-4)" }}>
          <Trophy size={30} aria-hidden="true" style={{ color: "var(--sb-faint)" }} />
          <h2 style={{ margin: "var(--sb-3) 0 4px", fontSize: 19 }}>No competition running</h2>
          <p className="sb-muted" style={{ margin: 0 }}>
            Predict a full slate of fixtures for a share of a pooled prize. Competitions are
            created by the operator with a fixed slate, entry price and prize structure.
          </p>
          <p className="sb-small sb-muted" style={{ maxWidth: 460, margin: "var(--sb-4) auto 0" }}>
            Entries, scoring and prize splitting are built and tested — including that the pool
            paid out equals the pool collected, to the kobo.
          </p>
          <div style={{ display: "flex", gap: "var(--sb-2)", justifyContent: "center", marginTop: "var(--sb-5)" }}>
            <Link href="/sports" className="sb-btn sb-btn--primary">Sports</Link>
            <Link href="/" className="sb-btn sb-btn--ghost">Home</Link>
          </div>
        </section>
      </PageShell>
    );
  }

  return (
    <PageShell title="Jackpot" sub={`${competitions.length} open`}>
      <div className="sb-stack-3">
        {competitions.map((competition) => (
          <section className="sb-panel sb-pad" key={competition.id}>
            <div className="sb-row-between sb-small sb-muted">
              <span>{competition.selectionCount} fixtures</span>
              <span>
                Closes {competition.closesAt.toLocaleString("en-NG", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <h2 style={{ margin: "var(--sb-2) 0", fontSize: "var(--sb-t-xl)", letterSpacing: "-0.02em" }}>
              {competition.name}
            </h2>

            <dl style={{ margin: "0 0 var(--sb-2)" }}>
              <div className="sb-total">
                <dt>Entry</dt>
                <dd>{naira(competition.entryFeeMinor)}</dd>
              </div>
              <div className="sb-total sb-total--major">
                <dt>Prize pool</dt>
                <dd>{naira(competition.poolMinor)}</dd>
              </div>
              <div className="sb-total">
                <dt>Entries</dt>
                <dd>{competition.entries}</dd>
              </div>
            </dl>

            <p className="sb-xs sb-muted" style={{ margin: 0 }}>
              The pool grows as more people enter. The figure above is what has actually been
              collected and guaranteed so far — not a headline.
            </p>
          </section>
        ))}
      </div>

      <p className="sb-xs sb-muted" style={{ marginTop: "var(--sb-4)" }}>
        Prizes are shared equally between everyone who scores the most correct predictions. If
        nobody reaches the advertised minimum, no prize is paid.
      </p>
    </PageShell>
  );
}
