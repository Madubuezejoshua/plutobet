"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Lock, Radio, TrendingDown, TrendingUp, WifiOff } from "lucide-react";
import type { LiveSnapshot } from "@/modules/odds/live-feed";
import { formatOdds } from "@/modules/odds/format";
import { SPORT_BY_KEY } from "@/modules/odds/sports-catalog";
import type { OddsFormat } from "@/modules/users/schema";

const POLL_INTERVAL_MS = 5_000;
const FLASH_DURATION_MS = 4_000;

const LIVE_CLOCK_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatLagosClock(iso: string): string {
  const parts = LIVE_CLOCK_FMT.formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

type OddsDirection = "up" | "down";

function extractPriceMap(snapshot: LiveSnapshot): Record<string, number> {
  const map: Record<string, number> = {};
  for (const event of snapshot.events) {
    for (const market of event.markets) {
      for (const selection of market.selections) {
        if (!selection.suspended && selection.price > 1) {
          map[selection.id] = selection.price;
        }
      }
    }
  }
  return map;
}

/**
 * The live board with automatic conditional polling, 2-way / 3-way column
 * alignment per sport, and live green/red odds-movement indicators.
 */
export function LiveBoard({
  sport,
  sportLabel,
  snapshot: initial,
  oddsFormat,
}: {
  sport: string;
  sportLabel: string;
  snapshot: LiveSnapshot;
  oddsFormat: OddsFormat;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [stale, setStale] = useState(false);
  const [flashes, setFlashes] = useState<Record<string, OddsDirection>>({});
  const prevPricesRef = useRef<Record<string, number>>(extractPriceMap(initial));

  const isTwoWay =
    Boolean(SPORT_BY_KEY[sport]?.twoWayDefault) &&
    !snapshot.events.some((ev) =>
      ev.markets.some(
        (m) => m.key === "1x2" && m.selections.some((s) => s.key === "draw"),
      ),
    );

  useEffect(() => {
    let cancelled = false;
    let version = initial.version;
    let clearFlashTimer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const response = await fetch(`/api/live?sport=${encodeURIComponent(sport)}`, {
          headers: { "if-none-match": `W/"${version}"` },
        });

        if (cancelled) return;

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

        const nextPrices = extractPriceMap(next);
        const prevPrices = prevPricesRef.current;
        const nextFlashes: Record<string, OddsDirection> = {};
        for (const [id, price] of Object.entries(nextPrices)) {
          const prev = prevPrices[id];
          if (typeof prev === "number" && prev !== price) {
            nextFlashes[id] = price > prev ? "up" : "down";
          }
        }
        prevPricesRef.current = nextPrices;

        if (Object.keys(nextFlashes).length > 0) {
          setFlashes(nextFlashes);
          if (clearFlashTimer) clearTimeout(clearFlashTimer);
          clearFlashTimer = setTimeout(() => {
            if (!cancelled) setFlashes({});
          }, FLASH_DURATION_MS);
        }

        version = next.version;
        setSnapshot(next);
        setStale(false);
      } catch {
        if (!cancelled) setStale(true);
      }
    }

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (clearFlashTimer) clearTimeout(clearFlashTimer);
    };
  }, [initial.version, sport]);

  if (snapshot.events.length === 0) {
    return (
      <section className="sb-panel">
        <div className="sb-empty">
          <Radio className="sb-empty__icon" size={26} aria-hidden="true" />
          <p className="sb-empty__title">No {sportLabel.toLowerCase()} matches in play</p>
          <p className="sb-small">
            Live {sportLabel.toLowerCase()} fixtures appear here once a match kicks off and the
            odds sync picks it up.
          </p>
        </div>
      </section>
    );
  }

  const columns = isTwoWay
    ? [
        { label: "1", key: "home" },
        { label: "2", key: "away" },
      ]
    : [
        { label: "1", key: "home" },
        { label: "X", key: "draw" },
        { label: "2", key: "away" },
      ];

  return (
    <>
      {stale ? (
        <p className="sb-note sb-note--warn" role="status" style={{ marginBottom: "var(--sb-2)" }}>
          <WifiOff size={14} aria-hidden="true" />
          Prices may be out of date — we could not reach the live feed. Reconnecting.
        </p>
      ) : null}

      <section className={`sb-panel sb-board ${isTwoWay ? "sb-board--live2" : "sb-board--3"}`}>
        <div className="sb-cols" aria-hidden="true">
          <span>Match</span>
          {columns.map((col) => (
            <span key={col.label} className="sb-cols__odds">
              {col.label}
            </span>
          ))}
        </div>

        {snapshot.events.map((event) => {
          const market = event.markets.find((m) => m.key === "1x2");
          return (
            <div className="sb-row" key={event.id}>
              <div className="sb-fixture">
                <span className="sb-fixture__time sb-num">
                  {event.status === "LIVE" ? (
                    <span className="sb-live">
                      <span className="sb-live__dot" aria-hidden="true" />
                      Live
                    </span>
                  ) : (
                    formatLagosClock(event.startsAt)
                  )}
                </span>
                <Link
                  href={`/sports/event/${event.providerEventId}`}
                  className="sb-fixture__teams sb-fixture__teamslink"
                >
                  <span className="sb-fixture__team">{event.fixture}</span>
                  {event.league ? (
                    <span className="sb-xs sb-muted">{event.league}</span>
                  ) : null}
                </Link>
                {event.homeScore !== null && event.awayScore !== null ? (
                  <span className="sb-score">
                    {event.homeScore}&nbsp;-&nbsp;{event.awayScore}
                  </span>
                ) : null}
              </div>

              {columns.map(({ label, key }) => {
                const selection = market?.selections.find((s) => s.key === key);
                const suspended = selection?.suspended ?? true;
                const direction = selection ? flashes[selection.id] : undefined;
                return (
                  <span
                    key={label}
                    className={`sb-odd${
                      direction === "up"
                        ? " sb-odd--flash-up"
                        : direction === "down"
                          ? " sb-odd--flash-down"
                          : ""
                    }`}
                    data-state={suspended ? "suspended" : "closed"}
                    title={
                      suspended
                        ? "Suspended"
                        : "Shown for information — in-play betting is not open yet"
                    }
                  >
                    <span className="sb-odd__label">{label}</span>
                    <span className="sb-odd__value sb-live-val">
                      {selection === undefined ? (
                        "—"
                      ) : suspended ? (
                        <Lock size={12} aria-label="Suspended" />
                      ) : (
                        <>
                          {formatOdds(selection.price, oddsFormat)}
                          {direction === "up" ? (
                            <TrendingUp size={11} className="sb-live-arrow--up" aria-label="Odds rose" />
                          ) : direction === "down" ? (
                            <TrendingDown size={11} className="sb-live-arrow--down" aria-label="Odds dropped" />
                          ) : null}
                        </>
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
