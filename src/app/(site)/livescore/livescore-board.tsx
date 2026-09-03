"use client";

import { useEffect, useState } from "react";
import type { LiveSnapshot } from "@/modules/odds/live-feed";

const POLL_INTERVAL_MS = 10_000;

/**
 * Live scores, no prices.
 *
 * Polls half as often as the odds board: a score changes far less frequently
 * than a price, so asking every five seconds would be paying for nothing. The
 * conditional request means an unchanged board costs a 304 either way.
 */
export function LiveScoreBoard({ snapshot: initial }: { snapshot: LiveSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);

  useEffect(() => {
    let cancelled = false;
    let version = initial.version;

    async function poll() {
      try {
        const response = await fetch("/api/live?sport=football", {
          headers: { "if-none-match": `W/"${version}"` },
        });
        if (cancelled || response.status === 304 || !response.ok) return;

        const next = (await response.json()) as LiveSnapshot;
        if (cancelled) return;
        version = next.version;
        setSnapshot(next);
      } catch {
        // A dropped poll on a scoreboard is not worth surfacing; the next one
        // usually lands, and a banner over a score people are watching would
        // be more annoying than the staleness it warns about.
      }
    }

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [initial.version]);

  const live = snapshot.events.filter((event) => event.status === "LIVE");
  const upcoming = snapshot.events.filter((event) => event.status !== "LIVE");

  if (snapshot.events.length === 0) {
    return (
      <section className="sb-panel">
        <div className="sb-empty">
          <p className="sb-empty__title">No fixtures loaded</p>
          <p className="sb-small">Matches appear here once the odds worker has run.</p>
        </div>
      </section>
    );
  }

  return (
    <>
      {live.length > 0 ? (
        <section className="sb-panel" style={{ marginBottom: "var(--sb-3)" }}>
          <div className="sb-panel__head"><h2 className="sb-panel__title">In play</h2></div>
          <table className="sb-table">
            <tbody>
              {live.map((event) => (
                <tr key={event.id}>
                  <td>
                    <span className="sb-live">
                      <span className="sb-live__dot" aria-hidden="true" />
                      Live
                    </span>{" "}
                    {event.fixture}
                  </td>
                  <td className="sb-table__num">
                    {event.homeScore === null || event.awayScore === null ? (
                      <span className="sb-muted">—</span>
                    ) : (
                      <strong>
                        {event.homeScore} - {event.awayScore}
                      </strong>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {upcoming.length > 0 ? (
        <section className="sb-panel">
          <div className="sb-panel__head"><h2 className="sb-panel__title">Upcoming</h2></div>
          <table className="sb-table">
            <tbody>
              {upcoming.map((event) => (
                <tr key={event.id}>
                  <td>{event.fixture}</td>
                  <td className="sb-table__num sb-muted sb-small">
                    {new Date(event.startsAt).toLocaleString("en-NG", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
