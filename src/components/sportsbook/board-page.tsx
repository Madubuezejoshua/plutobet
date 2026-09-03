import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { listUpcoming, type EventView } from "@/modules/odds/odds.service";
import { MatchBoard } from "./match-board";
import { LeagueRail, type RailLeague } from "./league-rail";
import { BetslipPanel } from "./betslip-panel";
import { DateStrip } from "./date-strip";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";

/**
 * The three-column sportsbook.
 *
 * This replaces a homepage that opened with a marketing hero and a wall of
 * product tiles. Betting content now begins in the first viewport, which is the
 * entire point of a sportsbook: the customer came to see a price.
 *
 * Data comes from the existing `listUpcoming` service. Nothing is fabricated —
 * an empty board says the board is empty.
 */

interface Props {
  sport?: string;
  league?: string;
  when?: string;
  /** A free-text search from the header, matched against teams and league. */
  q?: string;
  heading?: string;
}

function splitLeague(label: string) {
  const at = label.indexOf(" - ");
  if (at === -1) return { country: null as string | null, name: label };
  return { country: label.slice(0, at), name: label.slice(at + 3) };
}

function isToday(iso: string): boolean {
  const now = new Date();
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export async function SportsbookBoardPage({ sport = "football", league, when, q, heading }: Props) {
  const [session, fixtures] = await Promise.all([
    getServerSession(authOptions),
    listUpcoming({ sport, limit: 120 }).catch((error: unknown) => {
      // A board that 500s because one query failed is worse than a board that
      // renders and says it could not load. The customer can still navigate.
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

  /*
   * Search is a filter over the fixtures already loaded, not a second query.
   * It is honest about its scope in the heading below — "matches on the board"
   * — because a search that silently covers only what happens to be in memory,
   * while looking like it searched everything, is worse than no search.
   */
  const needle = q?.trim().toLowerCase() ?? "";
  if (needle) {
    shown = shown.filter(
      (f) =>
        f.home.toLowerCase().includes(needle) ||
        f.away.toLowerCase().includes(needle) ||
        f.league.toLowerCase().includes(needle),
    );
  }

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
