"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronLeft,
  ChevronRight,
  Flame,
  Pause,
  Play,
  Radio,
} from "lucide-react";
import type {
  HotShowcaseEvent,
  MarketView,
  SelectionView,
  SportHotCategory,
} from "@/modules/odds/odds.service";
import { OddsButton, type OddsState } from "./odds-button";
import {
  SLOTS_PER_CATEGORY,
  SPIN_INTERVAL_MS,
  SPINS_BEFORE_ROTATE,
  advanceCategoryRotation,
  canRotateCategory,
  sliceCategoryWindow,
  stepCategoryBatch,
  type CategoryRotationState,
} from "./hot-rotation";

interface LiveHotShowcaseProps {
  categories: SportHotCategory[];
  /** "home" links category headers to /sports?sport=..., "live" links to /live?sport=... */
  mode?: "home" | "live";
  /** Initial tab selection ("all" shows live + top priced upcoming; "live" filters strictly to LIVE). */
  defaultFilter?: "all" | "live";
}

const SHOWCASE_DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatLagosTime(iso: string): string {
  const parts = SHOWCASE_DATE_FMT.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;
}

function splitLeagueName(raw: string): string {
  const idx = raw.indexOf(" - ");
  return idx === -1 ? raw : raw.slice(idx + 3);
}

function marketFor(event: HotShowcaseEvent, key: string): MarketView | undefined {
  return event.markets.find((m) => m.key === key);
}

function selectionFor(market: MarketView | undefined, key: string): SelectionView | undefined {
  return market?.selections.find((s) => s.key === key);
}

function oddsState(market: MarketView | undefined, sel: SelectionView | undefined): OddsState {
  if (!market || !sel) return "unavailable";
  if (!(sel.price > 1)) return "suspended";
  return "open";
}

function ShowcaseMatchCard({
  event,
  twoWayDefault,
}: {
  event: HotShowcaseEvent;
  twoWayDefault: boolean;
}) {
  const isLive = event.status === "LIVE";
  const oneXTwo = marketFor(event, "1x2");
  const home = selectionFor(oneXTwo, "home");
  const draw = selectionFor(oneXTwo, "draw");
  const away = selectionFor(oneXTwo, "away");
  const isTwoWay = twoWayDefault && !draw;
  const fixture = `${event.home} v ${event.away}`;
  const eventHref = `/sports/event/${event.providerEventId}`;

  const pickFor = (sel: SelectionView | undefined) =>
    !isLive && oneXTwo && sel
      ? {
          selectionId: sel.id,
          eventId: event.id,
          marketKey: oneXTwo.key,
          selectionKey: sel.key,
          selectionLabel: sel.label,
          fixture,
          line: sel.line,
        }
      : undefined;

  const hasAnyPrice = Boolean(
    (home && home.price > 1) || (draw && draw.price > 1) || (away && away.price > 1),
  );

  return (
    <article className="sb-hotcard">
      <div className="sb-hotcard__meta">
        {isLive ? (
          <span className="sb-live">
            <span className="sb-live__dot" aria-hidden="true" />
            Live
          </span>
        ) : (
          <span className="sb-hotcard__time sb-num">{formatLagosTime(event.startsAt)}</span>
        )}
        <span className="sb-hotcard__sep" aria-hidden="true">
          ·
        </span>
        <span className="sb-hotcard__league" title={event.league}>
          {splitLeagueName(event.league)}
        </span>
        {event.homeScore !== null && event.awayScore !== null ? (
          <span className="sb-score sb-hotcard__score sb-num">
            {event.homeScore}-{event.awayScore}
          </span>
        ) : null}
      </div>

      <Link href={eventHref} className="sb-hotcard__teams">
        <span className="sb-hotcard__team">{event.home}</span>
        <span className="sb-hotcard__vs" aria-hidden="true">
          vs
        </span>
        <span className="sb-hotcard__team">{event.away}</span>
      </Link>

      {hasAnyPrice ? (
        isLive ? (
          <div
            className={`sb-hotcard__odds${isTwoWay ? " sb-hotcard__odds--2way" : ""}`}
            aria-label="In-play indicative odds"
          >
            {[
              { label: "1", sel: home },
              ...(isTwoWay ? [] : [{ label: "X", sel: draw }]),
              { label: "2", sel: away },
            ].map(({ label, sel }) => (
              <Link
                key={label}
                href={eventHref}
                className="sb-odd sb-hotcard__liveodd"
                data-state={sel && sel.price > 1 ? "closed" : "unavailable"}
                title="In-play odds for information — tap to open match"
              >
                <span className="sb-odd__label">{label}</span>
                <span className="sb-odd__value sb-num">
                  {sel && sel.price > 1 ? sel.price.toFixed(2) : "—"}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div className={`sb-hotcard__odds${isTwoWay ? " sb-hotcard__odds--2way" : ""}`}>
            <OddsButton
              label="1"
              price={home?.price ?? null}
              state={oddsState(oneXTwo, home)}
              pick={pickFor(home)}
            />
            {!isTwoWay ? (
              <OddsButton
                label="X"
                price={draw?.price ?? null}
                state={oddsState(oneXTwo, draw)}
                pick={pickFor(draw)}
              />
            ) : null}
            <OddsButton
              label="2"
              price={away?.price ?? null}
              state={oddsState(oneXTwo, away)}
              pick={pickFor(away)}
            />
          </div>
        )
      ) : (
        <div className="sb-hotcard__footerlink">
          <Link href={eventHref} className="sb-hotcard__more">
            <span>{isLive ? "View live match" : "View match markets"}</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      )}
    </article>
  );
}

/**
 * Multi-sport Live & Hot Games Showcase.
 *
 * Shows the top 2 playing / hot games from every active sport category.
 * Whenever a category has > 2 hot games (e.g. 5+ games), it tracks 5 spins on
 * the visible pair before smoothly switching to reveal the remaining games in
 * that category. Categories with <= 2 games remain steady with no unnecessary
 * switching.
 */
export function LiveHotShowcase({
  categories,
  mode = "home",
  defaultFilter = "all",
}: LiveHotShowcaseProps) {
  const [filter, setFilter] = useState<"all" | "live">(defaultFilter);
  const [paused, setPaused] = useState(false);
  const [hoveredSport, setHoveredSport] = useState<string | null>(null);
  const [rotationBySport, setRotationBySport] = useState<
    Record<string, CategoryRotationState>
  >({});

  const visibleCategories = useMemo(() => {
    if (filter === "all") return categories;
    return categories
      .map((cat) => ({
        ...cat,
        events: cat.events.filter((e) => e.status === "LIVE"),
      }))
      .filter((cat) => cat.events.length > 0);
  }, [categories, filter]);

  const totalLiveAcrossSports = useMemo(
    () => categories.reduce((sum, cat) => sum + cat.liveCount, 0),
    [categories],
  );

  const hasAnyRotatable = useMemo(
    () => visibleCategories.some((cat) => canRotateCategory(cat.events.length, SLOTS_PER_CATEGORY)),
    [visibleCategories],
  );

  useEffect(() => {
    if (paused || !hasAnyRotatable) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      setRotationBySport((prev) => {
        const next: Record<string, CategoryRotationState> = { ...prev };
        let changed = false;
        for (const cat of visibleCategories) {
          if (cat.sport === hoveredSport) continue;
          if (!canRotateCategory(cat.events.length, SLOTS_PER_CATEGORY)) continue;
          const current = prev[cat.sport] ?? { batchIndex: 0, spinCount: 0 };
          next[cat.sport] = advanceCategoryRotation(
            current,
            cat.events.length,
            SPINS_BEFORE_ROTATE,
            SLOTS_PER_CATEGORY,
          );
          changed = true;
        }
        return changed ? next : prev;
      });
    }, SPIN_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [paused, hasAnyRotatable, hoveredSport, visibleCategories]);

  if (categories.length === 0) return null;

  const stepSport = (sport: string, total: number, delta: number) => {
    setRotationBySport((prev) => ({
      ...prev,
      [sport]: stepCategoryBatch(
        prev[sport] ?? { batchIndex: 0, spinCount: 0 },
        total,
        delta,
        SLOTS_PER_CATEGORY,
      ),
    }));
  };

  return (
    <section
      className="sb-panel sb-hotshowcase"
      aria-label="Live and hot games across all sports"
    >
      <div className="sb-hotshowcase__head">
        <div className="sb-hotshowcase__titlegroup">
          <h2 className="sb-hotshowcase__title">
            {mode === "live" ? (
              <Radio size={15} className="sb-hotshowcase__icon--live" aria-hidden="true" />
            ) : (
              <Flame size={15} className="sb-hotshowcase__icon" aria-hidden="true" />
            )}
            <span>{mode === "live" ? "Live Across All Sports" : "Live & Hot Across Sports"}</span>
          </h2>
          <p className="sb-hotshowcase__sub">
            Top 2 per sport
            <span aria-hidden="true"> · </span>
            <span className="sb-num">{totalLiveAcrossSports}</span> live across{" "}
            <span className="sb-num">{categories.length}</span> sports
            {hasAnyRotatable ? (
              <>
                <span aria-hidden="true"> · </span>
                auto-switches after {SPINS_BEFORE_ROTATE} spins
              </>
            ) : null}
          </p>
        </div>

        <div className="sb-hotshowcase__actions">
          {totalLiveAcrossSports > 0 ? (
            <div className="sb-seg" role="tablist" aria-label="Showcase filter">
              <button
                type="button"
                role="tab"
                aria-selected={filter === "all"}
                className="sb-seg__btn"
                onClick={() => setFilter("all")}
              >
                All Hot
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filter === "live"}
                className="sb-seg__btn"
                onClick={() => setFilter("live")}
              >
                Live Only
              </button>
            </div>
          ) : null}

          {hasAnyRotatable ? (
            <button
              type="button"
              className="sb-hotshowcase__ctrl"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
              title={paused ? "Resume 5-spin auto-rotation" : "Pause 5-spin auto-rotation"}
            >
              {paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
              <span>{paused ? "Resume" : "Auto"}</span>
            </button>
          ) : null}
        </div>
      </div>

      {visibleCategories.length === 0 ? (
        <div className="sb-empty">
          <Radio className="sb-empty__icon" size={24} aria-hidden="true" />
          <p className="sb-empty__title">No matches in play right now</p>
          <p className="sb-small">Switch back to All Hot to browse upcoming top games.</p>
        </div>
      ) : (
        <div className="sb-hotshowcase__grid">
          {visibleCategories.map((cat) => {
            const rot = rotationBySport[cat.sport] ?? { batchIndex: 0, spinCount: 0 };
            const win = sliceCategoryWindow(cat.events, rot.batchIndex, SLOTS_PER_CATEGORY);
            const categoryHref =
              mode === "live"
                ? `/live?sport=${encodeURIComponent(cat.sport)}`
                : cat.sport === "football"
                  ? "/sports"
                  : `/sports?sport=${encodeURIComponent(cat.sport)}`;

            return (
              <div
                key={cat.sport}
                className="sb-hotcat"
                data-sport={cat.sport}
                data-batch={win.batchIndex}
                onMouseEnter={() => setHoveredSport(cat.sport)}
                onMouseLeave={() => setHoveredSport((cur) => (cur === cat.sport ? null : cur))}
              >
                <div className="sb-hotcat__head">
                  <div className="sb-hotcat__heading">
                    <Link href={categoryHref} className="sb-hotcat__name">
                      {cat.label}
                    </Link>
                    <span className="sb-hotcat__meta sb-num">
                      {cat.liveCount > 0 ? `${cat.liveCount} live` : `${cat.upcomingCount} upcoming`}
                      {win.canRotate ? ` · ${win.rangeStart}–${win.rangeEnd} of ${cat.events.length}` : ""}
                    </span>
                  </div>

                  <Link href={categoryHref} className="sb-hotcat__all">
                    <span>All</span>
                    <ChevronRight size={13} aria-hidden="true" />
                  </Link>
                </div>

                <div className="sb-hotcat__stage">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={`${cat.sport}-${win.batchIndex}`}
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -16 }}
                      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                      className="sb-hotcat__cards"
                    >
                      {win.items.map((event) => (
                        <ShowcaseMatchCard
                          key={event.id}
                          event={event}
                          twoWayDefault={cat.twoWayDefault}
                        />
                      ))}
                    </motion.div>
                  </AnimatePresence>
                </div>

                {win.canRotate ? (
                  <div className="sb-hotcat__foot">
                    <div
                      className="sb-hotcat__spins"
                      aria-label={`Spin ${rot.spinCount + 1} of ${SPINS_BEFORE_ROTATE} before switching to next ${cat.label} matches`}
                    >
                      {Array.from({ length: SPINS_BEFORE_ROTATE }, (_, i) => (
                        <span
                          key={i}
                          className={`sb-hotcat__pip${i <= rot.spinCount ? " sb-hotcat__pip--on" : ""}`}
                        />
                      ))}
                      <span className="sb-hotcat__spinlabel sb-num">
                        Spin {rot.spinCount + 1}/{SPINS_BEFORE_ROTATE}
                      </span>
                    </div>

                    <div className="sb-hotcat__nav">
                      <span className="sb-hotcat__set sb-num">
                        Set {win.batchIndex + 1}/{win.totalBatches}
                      </span>
                      <button
                        type="button"
                        className="sb-hotcat__navbtn"
                        aria-label={`Previous ${cat.label} hot games`}
                        onClick={() => stepSport(cat.sport, cat.events.length, -1)}
                      >
                        <ChevronLeft size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="sb-hotcat__navbtn"
                        aria-label={`Next ${cat.label} hot games`}
                        onClick={() => stepSport(cat.sport, cat.events.length, 1)}
                      >
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
