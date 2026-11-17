import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { listUpcoming, type EventView } from "@/modules/odds/odds.service";
import {
  pickHottestMatch,
  resolveBoardBadges,
  resolveMatchVisuals,
} from "@/modules/odds/featured-match";
import { MatchBoard } from "./match-board";
import { LeagueRail, type RailLeague } from "./league-rail";
import { BetslipPanel } from "./betslip-panel";
import { DateStrip } from "./date-strip";
import { HeroMatchBanner } from "./hero-match-banner";
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

export async function SportsbookBoardPage({
  sport = "football",
  league,
  when,
  q,
  heading,
  showHero = false,
}: Props) {
  const [session, fixtures] = await Promise.all([
    getServerSession(authOptions),
    listUpcoming({ sport, limit: 120 }).catch((error: unknown) => {
      console.error("[board] fixtures unavailable", error);
      return null;
    }),
  ]);

  const signedIn = Boolean(session?.user);
  const balanceMinor = signedIn ? await balanceFor(session!.user.id) : null;

  if (fixtures === null) {
    return (
      <Layout
        rail={<LeagueRail leagues={[]} todayCount={0} upcomingCount={0} />}
        slip={<BetslipPanel signedIn={signedIn} balanceMinor={balanceMinor} />}
      >
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

  const railLeagues = buildRail(fixtures);
  const todayCount = fixtures.filter((f) => isToday(f.startsAt)).length;

  let shown = fixtures;
  if (league) shown = shown.filter((f) => f.league === league);
  if (when === "today") shown = shown.filter((f) => isToday(f.startsAt));

  const needle = q?.trim().toLowerCase() ?? "";
  if (needle) {
    shown = shown.filter(
      (f) =>
        f.home.toLowerCase().includes(needle) ||
        f.away.toLowerCase().includes(needle) ||
        f.league.toLowerCase().includes(needle),
    );
  }

  const featured =
    showHero && !league && !needle && shown.length > 0
      ? pickHottestMatch(shown)
      : null;

  const [featuredVisuals, teamBadges] = await Promise.all([
    featured ? resolveMatchVisuals(featured) : Promise.resolve(undefined),
    resolveBoardBadges(shown),
  ]);

  const title = heading ?? (needle ? `Results for “${q}”` : league ? splitLeague(league).name : "Football");

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
      {featured ? <HeroMatchBanner event={featured} visuals={featuredVisuals} /> : null}

      <DateStrip active={when === "today" ? "today" : "all"} sport={sport} league={league} query={q} />

      <section className="sb-panel">
        <div className="sb-panel__head">
          <h1 className="sb-panel__title">{title}</h1>
          <span className="sb-small sb-muted" style={{ marginLeft: "auto" }}>
            {shown.length} {shown.length === 1 ? "match" : "matches"}
          </span>
        </div>

        <MatchBoard
          events={shown}
          teamBadges={teamBadges}
          emptyMessage={
            needle
              ? `Nothing on the board matches “${q}”. Try a team or competition name.`
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

function buildRail(events: EventView[]): RailLeague[] {
  const map = new Map<string, number>();
  for (const event of events) map.set(event.league, (map.get(event.league) ?? 0) + 1);
  return [...map.entries()]
    .map(([label, count]) => {
      const { country, name } = splitLeague(label);
      return { league: label, country, name, count };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
