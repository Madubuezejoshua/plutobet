"use client";

import { useEffect, useState } from "react";
import type { LiveSnapshot } from "@/modules/odds/live-feed";
import { formatOdds } from "@/modules/odds/format";
import type { OddsFormat } from "@/modules/users/schema";

const POLL_INTERVAL_MS = 5_000;

/**
 * The live board.
 *
 * Polls with a conditional request, so an unchanged board costs a 304 and no
 * payload. Five seconds is well inside what a price that moves every thirty
 * needs, and it scales the way the deployment target expects — see
 * modules/odds/live-feed.ts for why this is not a WebSocket.
 *
 * Prices are shown but NOT bettable from here yet: placing into a live market
 * needs the suspend-on-incident path to be driven by a real in-play feed, and
 * offering a tappable price that the server would refuse is worse than
 * offering none.
 */
export function LiveBoard({
  snapshot: initial,
  oddsFormat,
}: {
  snapshot: LiveSnapshot;
  oddsFormat: OddsFormat;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let version = initial.version;

    async function poll() {
      try {
        const response = await fetch("/api/live?sport=football", {
          headers: { "if-none-match": `W/"${version}"` },
        });

        if (cancelled) return;

        // 304: nothing moved. The common case, and it costs no payload.
        if (response.status === 304) {
          setStale(false);
          return;
        }
        if (!response.ok) {
          setStale(true);
          return;
        }

        const next = (await response.json()) as LiveSnapshot;
        if (cancelled) return;
        version = next.version;
        setSnapshot(next);
        setStale(false);
      } catch {
        // A dropped poll is not an error worth showing immediately — the next
        // one usually succeeds. Marking it stale tells the customer the prices
        // may have moved, which is the honest thing to say.
        if (!cancelled) setStale(true);
      }
    }

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [initial.version]);

  if (snapshot.events.length === 0) {
    return (
      <section className="card empty">
        <p>
          Nothing is in play. Live fixtures appear here once a match kicks off and the odds
          worker has picked it up.
        </p>
      </section>
    );
  }

  return (
    <>
      {stale ? (
        <p className="notice warn">
          Prices may be out of date — we could not reach the live feed. Reconnecting.
        </p>
      ) : null}

      <div className="fixtures">
        {snapshot.events.map((event) => (
          <article className="card" key={event.id}>
            <div className="fixture-head">
              <span className="league">
                {event.status === "LIVE" ? <span className="pill live">Live</span> : null}
              </span>
              <span>
                {new Date(event.startsAt).toLocaleTimeString("en-NG", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <div className="teams">
              {event.fixture}
              {event.homeScore !== null && event.awayScore !== null ? (
                <>
                  {" "}
                  <strong className="tnum">
                    {event.homeScore} - {event.awayScore}
                  </strong>
                </>
              ) : null}
            </div>

            {event.markets
              .filter((market) => market.key === "1x2")
              .map((market) => (
                <div className="odds-row" key={market.id}>
                  {market.selections.map((selection) => (
                    <span
                      key={selection.id}
                      className="odd"
                      role="presentation"
                      style={selection.suspended ? { opacity: 0.45 } : undefined}
                    >
                      <span className="odd-label">{selection.label}</span>
                      <span className="odd-price">
                        {/* A suspended price is shown as a lock, never as a
                            number — a visible price implies a bet we would
                            take, and we would refuse it. */}
                        {selection.suspended ? "🔒" : formatOdds(selection.price, oddsFormat)}
                      </span>
                    </span>
                  ))}
                </div>
              ))}
          </article>
        ))}
      </div>
    </>
  );
}
