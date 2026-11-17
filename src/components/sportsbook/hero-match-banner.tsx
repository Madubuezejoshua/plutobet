"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Flame } from "lucide-react";
import type { EventView, MarketView, SelectionView } from "@/modules/odds/odds.service";
import type { MatchVisuals, TeamVisual } from "@/modules/odds/featured-match";
import { OddsButton, type OddsState } from "./odds-button";

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
          sizes="220px"
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
      <div className="sb-hero__playerfade" />
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
  event,
  visuals,
}: {
  event: EventView;
  visuals?: MatchVisuals;
}) {
  const isLive = event.status === "LIVE";
  const oneXTwo = marketFor(event, "1x2");
  const home = selectionFor(oneXTwo, "home");
  const draw = selectionFor(oneXTwo, "draw");
  const away = selectionFor(oneXTwo, "away");

  const fixture = `${event.home} v ${event.away}`;
  const kickoff = new Date(event.startsAt);
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
          eventId: event.id,
          marketKey: oneXTwo.key,
          selectionKey: selection.key,
          selectionLabel: selection.label,
          fixture,
          line: selection.line,
        }
      : undefined;

  return (
    <section className="sb-hero" aria-label="Hottest match">
      <div className="sb-hero__glow" aria-hidden="true" />

      <HeroWingVisual
        key={`home-${event.id}-${visuals?.home.playerImageUrl ?? visuals?.home.badgeUrl ?? "none"}`}
        side="left"
        visual={visuals?.home}
      />
      <HeroWingVisual
        key={`away-${event.id}-${visuals?.away.playerImageUrl ?? visuals?.away.badgeUrl ?? "none"}`}
        side="right"
        visual={visuals?.away}
      />

      <div className={`sb-hero__badge${isLive ? " sb-hero__badge--live" : ""}`}>
        {isLive ? (
          <>
            <Flame size={12} aria-hidden="true" />
            <span>LIVE NOW</span>
          </>
        ) : (
          <>
            <Flame size={12} aria-hidden="true" />
            <span>HOTTEST MATCH</span>
          </>
        )}
      </div>

      <div className="sb-hero__center">
        <div className="sb-hero__league">{event.league}</div>
        <div className="sb-hero__teamrow">
          <TeamBadge
            key={`hbadge-${visuals?.home.badgeUrl ?? "none"}`}
            src={visuals?.home.badgeUrl}
          />
          <h2 className="sb-hero__team">{event.home}</h2>
        </div>
        <div className="sb-hero__vs" aria-hidden="true">
          VS
        </div>
        <div className="sb-hero__teamrow">
          <TeamBadge
            key={`abadge-${visuals?.away.badgeUrl ?? "none"}`}
            src={visuals?.away.badgeUrl}
          />
          <div className="sb-hero__team">{event.away}</div>
        </div>

        <div className="sb-hero__clock">
          {isLive ? "IN PLAY · LIVE MARKETS" : kickoffLabel}
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
          <Link href={`/sports/event/${event.providerEventId}`} className="sb-hero__cta">
            <span>All Markets</span>
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
