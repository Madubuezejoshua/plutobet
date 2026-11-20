"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Flame } from "lucide-react";
import type { EventView, MarketView, SelectionView } from "@/modules/odds/odds.service";
import type { MatchVisuals, TeamVisual } from "@/modules/odds/featured-match";
import { SPORT_BY_KEY, sportLabel } from "@/modules/odds/sports-catalog";
import { OddsButton, type OddsState } from "./odds-button";
import {
  SLOTS_PER_CATEGORY,
  SPINS_BEFORE_ROTATE,
  advanceCategoryRotation,
  buildMultiSportHeroDeck,
  canRotateCategory,
  type CategoryRotationState,
} from "./hot-rotation";

export interface HeroMatchSlide {
  event: EventView;
  visuals?: MatchVisuals;
}

export interface HeroSportPool {
  sport: string;
  label: string;
  slides: HeroMatchSlide[];
}

const AUTO_SWAP_MS = 5000;

function marketFor(event: EventView, key: string): MarketView | undefined {
  return event.markets.find((m) => m.key === key);
}

function selectionFor(market: MarketView | undefined, key: string): SelectionView | undefined {
  return market?.selections.find((s) => s.key === key);
}

function stateOf(market: MarketView | undefined, selection: SelectionView | undefined): OddsState {
  if (!market || !selection) return "unavailable";
  if (!(selection.price > 1)) return "suspended";
  return "open";
}

function HeroWingVisual({
  side,
  visual,
}: {
  side: "left" | "right";
  visual?: TeamVisual;
}) {
  const [badgeError, setBadgeError] = useState(false);
  const badgeUrl = !badgeError ? visual?.badgeUrl : null;

  if (!badgeUrl) return null;

  return (
    <div className={`sb-hero__player sb-hero__player--${side}`} aria-hidden="true">
      <div className="sb-hero__crestfallback">
        <Image
          src={badgeUrl}
          alt=""
          width={150}
          height={150}
          referrerPolicy="no-referrer"
          className="sb-hero__crestbg"
          onError={() => setBadgeError(true)}
        />
      </div>
    </div>
  );
}

function TeamBadge({ src }: { src: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;

  return (
    <Image
      src={src}
      alt=""
      width={24}
      height={24}
      referrerPolicy="no-referrer"
      className="sb-hero__crest"
      onError={() => setFailed(true)}
    />
  );
}

const HERO_DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatHeroKickoff(iso: string): string {
  const parts = HERO_DATE_FMT.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} · ${get("hour")}:${get("minute")}`;
}

interface HeroCarouselState {
  index: number;
  direction: number;
  rotationBySport: Record<string, CategoryRotationState>;
}

export function HeroMatchBanner({
  categoryPools,
  slides,
  event,
  visuals,
}: {
  /** Multi-sport ranked pools (shows 2 per sport, switching remaining after 5 spins when > 2). */
  categoryPools?: HeroSportPool[];
  slides?: HeroMatchSlide[];
  event?: EventView;
  visuals?: MatchVisuals;
}) {
  const useMultiSport = Boolean(categoryPools && categoryPools.length > 0);

  const [carousel, setCarousel] = useState<HeroCarouselState>({
    index: 0,
    direction: 1,
    rotationBySport: {},
  });
  const [hovered, setHovered] = useState(false);
  const [touchDragging, setTouchDragging] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const deckEntries = useMemo(() => {
    if (useMultiSport && categoryPools) {
      const batchBySport: Record<string, number> = {};
      for (const pool of categoryPools) {
        batchBySport[pool.sport] = carousel.rotationBySport[pool.sport]?.batchIndex ?? 0;
      }
      return buildMultiSportHeroDeck(
        categoryPools.map((p) => ({ sport: p.sport, items: p.slides })),
        batchBySport,
        SLOTS_PER_CATEGORY,
      );
    }

    const fallback: HeroMatchSlide[] =
      slides && slides.length > 0 ? slides : event ? [{ event, visuals }] : [];
    return fallback.map((slide) => ({
      sport: slide.event.sport,
      item: slide,
      batchIndex: 0,
      totalBatches: 1,
      canRotate: false,
    }));
  }, [useMultiSport, categoryPools, carousel.rotationBySport, slides, event, visuals]);

  const count = deckEntries.length;
  const safeIndex = count > 0 ? carousel.index % count : 0;
  const currentEntry = deckEntries[safeIndex];

  const stepTo = useCallback(
    (nextIdx: number, dir: number) => {
      if (count <= 1) return;
      setCarousel((prev) => ({
        ...prev,
        direction: dir,
        index: ((nextIdx % count) + count) % count,
      }));
    },
    [count],
  );

  useEffect(() => {
    if (count <= 1 || touchDragging || hovered) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      setCarousel((prev) => {
        const nextIdx = (prev.index + 1) % count;
        if (nextIdx !== 0 || !useMultiSport || !categoryPools) {
          return { ...prev, direction: 1, index: nextIdx };
        }
        // Completed a full cycle through the active hero deck: advance each
        // rotatable sport category's spin counter in the same pure update.
        const nextRot: Record<string, CategoryRotationState> = { ...prev.rotationBySport };
        for (const pool of categoryPools) {
          if (!canRotateCategory(pool.slides.length, SLOTS_PER_CATEGORY)) continue;
          nextRot[pool.sport] = advanceCategoryRotation(
            prev.rotationBySport[pool.sport] ?? { batchIndex: 0, spinCount: 0 },
            pool.slides.length,
            SPINS_BEFORE_ROTATE,
            SLOTS_PER_CATEGORY,
          );
        }
        return {
          index: 0,
          direction: 1,
          rotationBySport: nextRot,
        };
      });
    }, AUTO_SWAP_MS);

    return () => window.clearInterval(timer);
  }, [count, touchDragging, hovered, useMultiSport, categoryPools]);

  if (!currentEntry) return null;

  const current = currentEntry.item;
  const activeEvent = current.event;
  const activeVisuals = current.visuals;
  const isLive = activeEvent.status === "LIVE";
  const oneXTwo = marketFor(activeEvent, "1x2");
  const home = selectionFor(oneXTwo, "home");
  const draw = selectionFor(oneXTwo, "draw");
  const away = selectionFor(oneXTwo, "away");
  const isTwoWay = Boolean(SPORT_BY_KEY[activeEvent.sport]?.twoWayDefault) && !draw;
  const activeSportLabel = sportLabel(activeEvent.sport);

  const fixture = `${activeEvent.home} v ${activeEvent.away}`;
  const kickoffLabel = formatHeroKickoff(activeEvent.startsAt);

  const pickFor = (selection: SelectionView | undefined) =>
    !isLive && oneXTwo && selection
      ? {
          selectionId: selection.id,
          eventId: activeEvent.id,
          marketKey: oneXTwo.key,
          selectionKey: selection.key,
          selectionLabel: selection.label,
          fixture,
          line: selection.line,
        }
      : undefined;

  return (
    <section
      className="sb-hero"
      aria-label="Hottest matches across sports"
      aria-roledescription={count > 1 ? "carousel" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onTouchStart={(e) => {
        if (count <= 1) return;
        const touch = e.touches[0];
        if (!touch) return;
        touchStartRef.current = { x: touch.clientX, y: touch.clientY };
        setTouchDragging(true);
      }}
      onTouchEnd={(e) => {
        setTouchDragging(false);
        if (count <= 1 || !touchStartRef.current) return;
        const touch = e.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - touchStartRef.current.x;
        const dy = touch.clientY - touchStartRef.current.y;
        touchStartRef.current = null;
        if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0) stepTo(safeIndex + 1, 1);
          else stepTo(safeIndex - 1, -1);
        }
      }}
      onTouchCancel={() => {
        setTouchDragging(false);
        touchStartRef.current = null;
      }}
    >
      <div className="sb-hero__glow" aria-hidden="true" />

      {count > 1 ? (
        <>
          <button
            type="button"
            className="sb-hero__arrow sb-hero__arrow--prev"
            aria-label="Previous hot match"
            onClick={() => stepTo(safeIndex - 1, -1)}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="sb-hero__arrow sb-hero__arrow--next"
            aria-label="Next hot match"
            onClick={() => stepTo(safeIndex + 1, 1)}
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </>
      ) : null}

      <AnimatePresence mode="wait" initial={false} custom={carousel.direction}>
        <motion.div
          key={activeEvent.id}
          custom={carousel.direction}
          initial={{ x: carousel.direction * 28, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: carousel.direction * -28, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="sb-hero__slide"
          data-slide-id={activeEvent.id}
          data-slide-index={safeIndex}
          data-sport={activeEvent.sport}
        >
          <HeroWingVisual
            key={`home-${activeEvent.id}-${activeVisuals?.home.playerImageUrl ?? activeVisuals?.home.badgeUrl ?? "none"}`}
            side="left"
            visual={activeVisuals?.home}
          />
          <HeroWingVisual
            key={`away-${activeEvent.id}-${activeVisuals?.away.playerImageUrl ?? activeVisuals?.away.badgeUrl ?? "none"}`}
            side="right"
            visual={activeVisuals?.away}
          />

          <div className={`sb-hero__badge${isLive ? " sb-hero__badge--live" : ""}`}>
            <Flame size={12} aria-hidden="true" />
            <span>
              {activeSportLabel} · {isLive ? "LIVE NOW" : "HOTTEST MATCH"}
              {currentEntry.canRotate
                ? ` · SET ${currentEntry.batchIndex + 1}/${currentEntry.totalBatches}`
                : ""}
            </span>
          </div>

          <div className="sb-hero__center">
            <div className="sb-hero__league">{activeEvent.league}</div>
            <div className="sb-hero__teamrow">
              <TeamBadge
                key={`hbadge-${activeVisuals?.home.badgeUrl ?? "none"}`}
                src={activeVisuals?.home.badgeUrl}
              />
              <h2 className="sb-hero__team">{activeEvent.home}</h2>
            </div>
            <div className="sb-hero__vs" aria-hidden="true">
              VS
            </div>
            <div className="sb-hero__teamrow">
              <TeamBadge
                key={`abadge-${activeVisuals?.away.badgeUrl ?? "none"}`}
                src={activeVisuals?.away.badgeUrl}
              />
              <div className="sb-hero__team">{activeEvent.away}</div>
            </div>

            <div className="sb-hero__clock">
              {isLive ? "IN PLAY · LIVE ODDS" : kickoffLabel}
            </div>

            <div className="sb-hero__controls">
              {isLive ? (
                <div className="sb-hero__odds" aria-label="In-play indicative odds">
                  {[
                    { label: "1", sel: home },
                    ...(isTwoWay ? [] : [{ label: "X", sel: draw }]),
                    { label: "2", sel: away },
                  ].map(({ label, sel }) => (
                    <span
                      key={label}
                      className="sb-odd"
                      data-state={sel && sel.price > 1 ? "closed" : "unavailable"}
                      title="In-play odds shown for information"
                    >
                      <span className="sb-odd__label">{label}</span>
                      <span className="sb-odd__value sb-num">
                        {sel && sel.price > 1 ? sel.price.toFixed(2) : "—"}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="sb-hero__odds">
                  <OddsButton
                    label="1"
                    price={home?.price ?? null}
                    state={stateOf(oneXTwo, home)}
                    pick={pickFor(home)}
                  />
                  {!isTwoWay ? (
                    <OddsButton
                      label="X"
                      price={draw?.price ?? null}
                      state={stateOf(oneXTwo, draw)}
                      pick={pickFor(draw)}
                    />
                  ) : null}
                  <OddsButton
                    label="2"
                    price={away?.price ?? null}
                    state={stateOf(oneXTwo, away)}
                    pick={pickFor(away)}
                  />
                </div>
              )}
              <Link
                href={`/sports/event/${activeEvent.providerEventId}`}
                className="sb-hero__cta"
                aria-label={`Match odds for ${fixture}`}
              >
                <span>Match Odds</span>
                <ChevronRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>

      {count > 1 ? (
        <div className="sb-hero__dots" role="tablist" aria-label="Featured hot matches">
          {deckEntries.map((entry, idx) => (
            <button
              key={entry.item.event.id}
              type="button"
              role="tab"
              aria-selected={idx === safeIndex}
              aria-label={`Show ${sportLabel(entry.sport)}: ${entry.item.event.home} vs ${entry.item.event.away}`}
              className="sb-hero__dotbtn"
              onClick={() => stepTo(idx, idx > safeIndex ? 1 : -1)}
            >
              <span className="sb-hero__dot" />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
