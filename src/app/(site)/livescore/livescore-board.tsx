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
      <section className="card empty">
        <p>No fixtures are loaded. Matches appear here once the odds worker has run.</p>
      </section>
    );
  }

  return (
    <>
      {live.length > 0 ? (
        <section className="card">
          <h2>In play</h2>
          <div className="scroll-x">
            <table className="statement">
              <tbody>
                {live.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <span className="pill live">Live</span> {event.fixture}
                    </td>
                    <td className="right">
                      {event.homeScore === null || event.awayScore === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <strong className="tnum">
                          {event.homeScore} - {event.awayScore}
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

      {upcoming.length > 0 ? (
        <section className="card">
          <h2>Upcoming</h2>
          <div className="scroll-x">
            <table className="statement">
              <tbody>
                {upcoming.map((event) => (
                  <tr key={event.id}>
                    <td>{event.fixture}</td>
                    <td className="right muted small">
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
          </div>
        </section>
      ) : null}
    </>
  );
}
