"use client";

import { useEffect, useState } from "react";
import { Lock, Radio, WifiOff } from "lucide-react";
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
 *
 * So every price here is rendered as a static tile in the `closed` state, not
 * as a button. That is the whole reason the odds tile carries its state in a
 * `data-state` attribute rather than in a click handler: a price can be shown
 * without implying it can be taken.
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
      <section className="sb-panel">
        <div className="sb-empty">
          <Radio className="sb-empty__icon" size={26} aria-hidden="true" />
          <p className="sb-empty__title">Nothing is in play</p>
          <p className="sb-small">
            Live fixtures appear here once a match kicks off and the odds worker has picked it up.
          </p>
        </div>
      </section>
    );
  }

  return (
    <>
      {stale ? (
        <p className="sb-note sb-note--warn" role="status" style={{ marginBottom: "var(--sb-2)" }}>
          <WifiOff size={14} aria-hidden="true" />
          Prices may be out of date — we could not reach the live feed. Reconnecting.
        </p>
      ) : null}

      <section className="sb-panel sb-board sb-board--3">
        {/*
          A VISUAL column legend, not a table header.

          This carried `role="row"` with `role="columnheader"` children, and axe
          reported `aria-required-parent` as CRITICAL: a row must live inside a
          table, grid or rowgroup, and nothing here is one. The rows below are
          plain `.sb-row` divs with no cell roles, so the strip was the only part
          of the board claiming table semantics — it promised a structure a
          screen reader would then fail to find.

          Making it presentational is what `match-board.tsx` already does, and it
          is the honest description: the odds controls below carry their own
          accessible names, so nothing is lost by hiding a legend that only
          repeats "1 X 2".
        */}
        <div className="sb-cols" aria-hidden="true">
          <span>Match</span>
          <span className="sb-cols__odds">1</span>
          <span className="sb-cols__odds">X</span>
          <span className="sb-cols__odds">2</span>
        </div>

        {snapshot.events.map((event) => {
          const market = event.markets.find((m) => m.key === "1x2");
          return (
            <div className="sb-row" key={event.id}>
              <div className="sb-fixture">
                <span className="sb-fixture__time">
                  {event.status === "LIVE" ? (
                    <span className="sb-live">
                      <span className="sb-live__dot" aria-hidden="true" />
                      Live
                    </span>
                  ) : (
                    new Date(event.startsAt).toLocaleTimeString("en-NG", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  )}
                </span>
                <span className="sb-fixture__teams">
                  <span className="sb-fixture__team">{event.fixture}</span>
                </span>
                {event.homeScore !== null && event.awayScore !== null ? (
                  <span className="sb-score">
                    {event.homeScore}&nbsp;-&nbsp;{event.awayScore}
                  </span>
                ) : null}
              </div>

              {["1", "X", "2"].map((label, index) => {
                const selection = market?.selections[index];
                const suspended = selection?.suspended ?? true;
                return (
                  <span
                    key={label}
                    className="sb-odd"
                    data-state={suspended ? "suspended" : "closed"}
                    title={
                      suspended
                        ? "Suspended"
                        : "Shown for information — in-play betting is not open yet"
                    }
                  >
                    <span className="sb-odd__label">{label}</span>
                    <span className="sb-odd__value">
                      {selection === undefined ? (
                        "—"
                      ) : suspended ? (
                        <Lock size={12} aria-label="Suspended" />
                      ) : (
                        formatOdds(selection.price, oddsFormat)
                      )}
                    </span>
                  </span>
                );
              })}
            </div>
          );
        })}
      </section>
    </>
  );
}
