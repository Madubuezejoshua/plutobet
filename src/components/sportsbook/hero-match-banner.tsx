"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Flame } from "lucide-react";
import type { EventView, MarketView, SelectionView } from "@/modules/odds/odds.service";
import type { MatchVisuals, TeamVisual } from "@/modules/odds/featured-match";
import { OddsButton, type OddsState } from "./odds-button";

export interface HeroMatchSlide {
  event: EventView;
  visuals?: MatchVisuals;
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
  const [playerError, setPlayerError] = useState(false);
  const [badgeError, setBadgeError] = useState(false);

  const playerUrl = !playerError ? visual?.playerImageUrl : null;
  const badgeUrl = !badgeError ? visual?.badgeUrl : null;

  if (!playerUrl && !badgeUrl) return null;

  return (
    <div className={`sb-hero__player sb-hero__player--${side}`} aria-hidden="true">
      {playerUrl ? (
        <Image
          src={playerUrl}
          alt=""
          fill
          sizes="(max-width: 600px) 116px, 220px"
          priority
          referrerPolicy="no-referrer"
          className="sb-hero__playerimg"
          onError={() => setPlayerError(true)}
        />
      ) : badgeUrl ? (
        <div className="sb-hero__crestfallback">
          <Image
            src={badgeUrl}
            alt=""
            width={116}
            height={116}
            referrerPolicy="no-referrer"
            className="sb-hero__crestbg"
            onError={() => setBadgeError(true)}
          />
        </div>
      ) : null}
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

export function HeroMatchBanner({
  slides,
  event,
  visuals,
}: {
  slides?: HeroMatchSlide[];
  event?: EventView;
  visuals?: MatchVisuals;
}) {
  const items: HeroMatchSlide[] =
    slides && slides.length > 0 ? slides : event ? [{ event, visuals }] : [];

  const count = items.length;
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [touchDragging, setTouchDragging] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const safeIndex = count > 0 ? index % count : 0;
  const current = items[safeIndex];

  const stepTo = useCallback(
    (nextIdx: number, dir: number) => {
      if (count <= 1) return;
      setDirection(dir);
      setIndex(((nextIdx % count) + count) % count);
    },
    [count],
  );

  useEffect(() => {
    if (count <= 1 || touchDragging) return;
    const timer = window.setInterval(() => {
      setDirection(1);
      setIndex((prev) => (prev + 1) % count);
    }, AUTO_SWAP_MS);
    return () => window.clearInterval(timer);
  }, [count, touchDragging, safeIndex]);

  if (!current) return null;

  const activeEvent = current.event;
  const activeVisuals = current.visuals;
  const isLive = activeEvent.status === "LIVE";
  const oneXTwo = marketFor(activeEvent, "1x2");
  const home = selectionFor(oneXTwo, "home");
  const draw = selectionFor(oneXTwo, "draw");
  const away = selectionFor(oneXTwo, "away");

  const fixture = `${activeEvent.home} v ${activeEvent.away}`;
  const kickoff = new Date(activeEvent.startsAt);
  const kickoffLabel = kickoff.toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const pickFor = (selection: SelectionView | undefined) =>
    oneXTwo && selection
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
      aria-label="Hottest matches"
      aria-roledescription={count > 1 ? "carousel" : undefined}
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

      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          key={activeEvent.id}
          custom={direction}
          initial={{ x: direction * 36, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: direction * -36, opacity: 0 }}
          transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
          className="sb-hero__slide"
          data-slide-id={activeEvent.id}
          data-slide-index={safeIndex}
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
            <span>{isLive ? "LIVE NOW" : "HOTTEST MATCH"}</span>
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
              <div className="sb-hero__odds">
                <OddsButton
                  label="1"
                  price={home?.price ?? null}
                  state={stateOf(oneXTwo, home)}
                  pick={pickFor(home)}
                />
                <OddsButton
                  label="X"
                  price={draw?.price ?? null}
                  state={stateOf(oneXTwo, draw)}
                  pick={pickFor(draw)}
                />
                <OddsButton
                  label="2"
                  price={away?.price ?? null}
                  state={stateOf(oneXTwo, away)}
                  pick={pickFor(away)}
                />
              </div>
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
          {items.map((item, idx) => (
            <button
              key={item.event.id}
              type="button"
              role="tab"
              aria-selected={idx === safeIndex}
              aria-label={`Show ${item.event.home} vs ${item.event.away}`}
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
