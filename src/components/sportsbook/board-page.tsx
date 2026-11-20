import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import {
  listHotShowcaseBySport,
  listUpcoming,
  type EventView,
  type SportHotCategory,
} from "@/modules/odds/odds.service";
import { leaguePriority, resolveSportKey, sportLabel } from "@/modules/odds/sports-catalog";
import {
  pickHotMatches,
  resolveBoardBadges,
  resolveMatchVisuals,
} from "@/modules/odds/featured-match";
import { MatchBoard } from "./match-board";
import { LeagueRail, type RailLeague } from "./league-rail";
import { BetslipPanel } from "./betslip-panel";
import { DateStrip, type QuickLeagueItem } from "./date-strip";
import { HeroMatchBanner, type HeroSportPool } from "./hero-match-banner";
import { LiveHotShowcase } from "./live-hot-showcase";
import { QuickCodeBar } from "./quick-code-bar";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";

interface Props {
  sport?: string;
  league?: string;
  when?: string;
  /** A free-text search from the header, matched against teams and league. */
  q?: string;
  heading?: string;
  showHero?: boolean;
}

function splitLeague(label: string) {
  const at = label.indexOf(" - ");
  if (at === -1) return { country: null as string | null, name: label };
  return { country: label.slice(0, at), name: label.slice(at + 3) };
}

const lagosDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function isToday(iso: string): boolean {
  return lagosDayFormatter.format(new Date(iso)) === lagosDayFormatter.format(new Date());
}

function isNext3Hours(iso: string): boolean {
  const nowMs = new Date().getTime();
  const start = Date.parse(iso);
  return start >= nowMs - 15 * 60_000 && start <= nowMs + 3 * 60 * 60_000;
}

export async function SportsbookBoardPage({
  sport: rawSport = "football",
  league,
  when,
  q,
  heading,
  showHero = false,
}: Props) {
  const sport = resolveSportKey(rawSport);
  const wantMultiSportShowcase = showHero && !league && !q;

  const [session, fixtures, hotCategories] = await Promise.all([
    getServerSession(authOptions),
    listUpcoming({ sport, limit: 180 }).catch((error: unknown) => {
      console.error("[board] fixtures unavailable", error);
      return null;
    }),
    wantMultiSportShowcase
      ? listHotShowcaseBySport({ perSport: 8 }).catch((error: unknown) => {
          console.error("[board] multi-sport showcase unavailable", error);
          return [] as SportHotCategory[];
        })
      : Promise.resolve([] as SportHotCategory[]),
  ]);

  const signedIn = Boolean(session?.user);
  const balanceMinor = signedIn ? await balanceFor(session!.user.id) : null;

  if (fixtures === null) {
    return (
      <Layout
        rail={<LeagueRail leagues={[]} todayCount={0} upcomingCount={0} />}
        slip={<BetslipPanel signedIn={signedIn} balanceMinor={balanceMinor} />}
      >
        <QuickCodeBar />
        <section className="sb-panel">
          <div className="sb-empty">
            <AlertTriangle className="sb-empty__icon" size={28} aria-hidden="true" />
            <p className="sb-empty__title">We could not load the board</p>
            <p className="sb-small">
              This is on our side, not yours. Please refresh in a moment.
            </p>
          </div>
        </section>
      </Layout>
    );
  }

  const railLeagues = buildRail(fixtures, sport);
  const liveCount = fixtures.filter((f) => f.status === "LIVE").length;
  const next3hCount = fixtures.filter((f) => isNext3Hours(f.startsAt)).length;
  const todayCount = fixtures.filter((f) => isToday(f.startsAt)).length;

  const activeWhen: "live" | "3h" | "today" | "all" =
    when === "live" || when === "3h" || when === "today" ? when : "all";

  let shown = fixtures;
  if (league) shown = shown.filter((f) => f.league === league);
  if (activeWhen === "live") shown = shown.filter((f) => f.status === "LIVE");
  else if (activeWhen === "3h") shown = shown.filter((f) => isNext3Hours(f.startsAt));
  else if (activeWhen === "today") shown = shown.filter((f) => isToday(f.startsAt));

  const needle = q?.trim().toLowerCase() ?? "";
  if (needle) {
    shown = shown.filter(
      (f) =>
        f.home.toLowerCase().includes(needle) ||
        f.away.toLowerCase().includes(needle) ||
        f.league.toLowerCase().includes(needle),
    );
  }

  // Keep priced matches visible at the top while preserving kickoff order.
  shown = [...shown].sort((a, b) => {
    const aPriced = a.markets.length > 0 ? 0 : 1;
    const bPriced = b.markets.length > 0 ? 0 : 1;
    if (aPriced !== bPriced) return aPriced - bPriced;
    return Date.parse(a.startsAt) - Date.parse(b.startsAt);
  });

  const hotMatches =
    showHero && !league && !needle && shown.length > 0 && hotCategories.length === 0
      ? pickHotMatches(shown, 5)
      : [];

  // Resolve visuals for the top 2 hero-visible matches of the leading categories
  // so homepage render stays fast while major football/NBA crests appear crisply.
  const heroVisualTargetEvents =
    hotCategories.length > 0
      ? hotCategories
          .slice(0, 6)
          .flatMap((cat) => cat.events.slice(0, 2))
      : hotMatches;

  const [resolvedVisualsList, teamBadges] = await Promise.all([
    Promise.all(heroVisualTargetEvents.map((match) => resolveMatchVisuals(match))),
    resolveBoardBadges(shown),
  ]);

  const visualsByEventId = new Map(
    heroVisualTargetEvents.map((ev, idx) => [ev.id, resolvedVisualsList[idx]]),
  );

  const heroCategoryPools: HeroSportPool[] =
    showHero && !league && !needle && hotCategories.length > 0
      ? hotCategories.slice(0, 8).map((cat) => ({
          sport: cat.sport,
          label: cat.label,
          slides: cat.events.slice(0, 6).map((event) => ({
            event,
            visuals: visualsByEventId.get(event.id),
          })),
        }))
      : [];

  const hotSlides = hotMatches.map((event) => ({
    event,
    visuals: visualsByEventId.get(event.id),
  }));

  const defaultSportTitle = sportLabel(sport);
  const title =
    heading ??
    (needle
      ? `Results for “${q}”`
      : league
        ? splitLeague(league).name
        : activeWhen === "live"
          ? `${defaultSportTitle} — Live Now`
          : activeWhen === "3h"
            ? `${defaultSportTitle} — Next 3 Hours`
            : defaultSportTitle);

  const topLeagues: QuickLeagueItem[] = railLeagues.slice(0, 8).map((entry) => ({
    league: entry.league,
    name: entry.name,
    count: entry.count,
  }));

  return (
    <Layout
      rail={
        <LeagueRail
          leagues={railLeagues}
          activeLeague={league}
          todayCount={todayCount}
          upcomingCount={fixtures.length}
        />
      }
      slip={<BetslipPanel signedIn={signedIn} balanceMinor={balanceMinor} />}
    >
      {heroCategoryPools.length > 0 ? (
        <HeroMatchBanner categoryPools={heroCategoryPools} />
      ) : hotSlides.length > 0 ? (
        <HeroMatchBanner slides={hotSlides} />
      ) : null}

      <QuickCodeBar />

      {wantMultiSportShowcase && activeWhen === "all" && hotCategories.length > 0 ? (
        <LiveHotShowcase categories={hotCategories} mode="home" defaultFilter="all" />
      ) : null}

      <DateStrip
        active={activeWhen}
        sport={sport}
        league={league}
        query={q}
        counts={{
          all: fixtures.length,
          live: liveCount,
          next3h: next3hCount,
          today: todayCount,
        }}
        topLeagues={topLeagues}
      />

      {railLeagues.length > 0 ? (
        <div className="sb-panel sb-mobileleagues" style={{ marginBottom: "var(--sb-3)" }}>
          <nav className="sb-chips" aria-label="Filter by competition">
            <Link
              href={
                sport && sport !== "football"
                  ? `/sports?sport=${encodeURIComponent(sport)}`
                  : "/sports"
              }
              className="sb-chip"
              aria-current={!league ? "true" : undefined}
            >
              All leagues
              <span className="sb-railitem__count">{fixtures.length}</span>
            </Link>
            {railLeagues.map((entry) => {
              const params = new URLSearchParams();
              if (sport && sport !== "football") params.set("sport", sport);
              params.set("league", entry.league);
              if (activeWhen !== "all") params.set("when", activeWhen);
              return (
                <Link
                  key={entry.league}
                  href={`/sports?${params.toString()}`}
                  className="sb-chip"
                  aria-current={league === entry.league ? "true" : undefined}
                >
                  <span>{entry.name}</span>
                  <span className="sb-railitem__count">{entry.count}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      ) : null}

      <section className="sb-panel">
        <div className="sb-panel__head">
          <h1 className="sb-panel__title">{title}</h1>
          <span className="sb-small sb-muted" style={{ marginLeft: "auto" }}>
            {shown.length} {shown.length === 1 ? "match" : "matches"}
          </span>
        </div>

        <MatchBoard
          events={shown}
          sport={sport}
          teamBadges={teamBadges}
          emptyMessage={
            needle
              ? `Nothing on the board matches “${q}”. Try a team or competition name.`
              : activeWhen === "live"
                ? `No ${defaultSportTitle.toLowerCase()} matches are live right now.`
                : activeWhen === "3h"
                  ? `No ${defaultSportTitle.toLowerCase()} matches kick off in the next 3 hours.`
                  : league
                    ? "No matches with prices in this competition right now."
                    : "No matches with prices right now. Check back shortly."
          }
        />
      </section>

      <p className="sb-xs sb-muted" style={{ padding: "var(--sb-3)", margin: 0 }}>
        Odds are supplied by our pricing feed and can change at any time. Your bet is
        settled at the price confirmed when it is accepted.{" "}
        <Link href="/responsible">Bet responsibly</Link>.
      </p>
    </Layout>
  );
}

function Layout({
  rail,
  slip,
  children,
}: {
  rail: React.ReactNode;
  slip: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="sb-shellgrid">
      <aside className="sb-railcol">{rail}</aside>
      <main>{children}</main>
      <aside className="sb-slipcol">{slip}</aside>
    </div>
  );
}

function buildRail(events: EventView[], sport: string): RailLeague[] {
  const map = new Map<string, number>();
  for (const event of events) map.set(event.league, (map.get(event.league) ?? 0) + 1);
  return [...map.entries()]
    .map(([label, count]) => {
      const { country, name } = splitLeague(label);
      return { league: label, country, name, count };
    })
    .sort((a, b) => {
      const pa = leaguePriority(sport, a.league);
      const pb = leaguePriority(sport, b.league);
      if (pa !== pb) return pa - pb;
      return b.count - a.count || a.name.localeCompare(b.name);
    });
}

async function balanceFor(userId: string): Promise<string | null> {
  try {
    const walletId = await walletForUser(userId);
    if (!walletId) return null;
    return (await walletService.getBalance(walletId)).toString();
  } catch (error) {
    console.error("[board] balance unavailable", error);
    return null;
  }
}
