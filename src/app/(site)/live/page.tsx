import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { liveSnapshot, type LiveSnapshot } from "@/modules/odds/live-feed";
import { getSportCounts } from "@/modules/odds/odds.service";
import { resolveSportKey, SPORTS_CATALOG, sportLabel } from "@/modules/odds/sports-catalog";
import { profileService } from "@/modules/users/profile.service";
import { LiveBoard } from "./live-board";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Live" };

export default async function LivePage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string }>;
}) {
  const params = await searchParams;
  const activeSport = resolveSportKey(params.sport);
  const activeLabel = sportLabel(activeSport);

  const session = await getServerSession(authOptions);

  const [snapshot, preferences, sportCounts] = await Promise.all([
    liveSnapshot(activeSport).catch((error: unknown) => {
      console.error("[live] snapshot unavailable", error);
      return { version: "0-0", events: [] } as LiveSnapshot;
    }),
    session?.user
      ? profileService.preferences(session.user.id).catch(() => null)
      : Promise.resolve(null),
    getSportCounts().catch(() => ({} as Record<string, { upcoming: number; live: number }>)),
  ]);

  const inPlay = snapshot.events.filter((event) => event.status === "LIVE").length;

  return (
    <PageShell
      title="Live"
      sub={
        inPlay > 0
          ? `${inPlay} ${activeLabel.toLowerCase()} in play · prices refresh every 5s`
          : `No ${activeLabel.toLowerCase()} matches in play right now`
      }
    >
      <nav
        className="sb-chips"
        aria-label="Filter live matches by sport"
        style={{ marginBottom: "var(--sb-3)" }}
      >
        {SPORTS_CATALOG.map((sport) => {
          const liveNum = sportCounts[sport.key]?.live ?? 0;
          return (
            <Link
              key={sport.key}
              href={sport.key === "football" ? "/live" : `/live?sport=${sport.key}`}
              className="sb-chip"
              aria-current={activeSport === sport.key ? "true" : undefined}
            >
              {liveNum > 0 ? <span className="sb-live__dot" aria-hidden="true" /> : null}
              <span>{sport.label}</span>
              {liveNum > 0 ? <span className="sb-chip__count">{liveNum}</span> : null}
            </Link>
          );
        })}
      </nav>

      <LiveBoard
        key={activeSport}
        sport={activeSport}
        sportLabel={activeLabel}
        snapshot={snapshot}
        oddsFormat={preferences?.oddsFormat ?? "DECIMAL"}
      />

      <p className="sb-xs sb-muted" style={{ marginTop: "var(--sb-4)" }}>
        Live prices are shown for information with automatic movement indicators. In-play betting
        opens once a real-time incident suspension feed is connected — a tappable price we would
        then refuse is worse than no price at all.
      </p>
    </PageShell>
  );
}
