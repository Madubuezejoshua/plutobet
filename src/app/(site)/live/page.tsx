import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { liveSnapshot, type LiveSnapshot } from "@/modules/odds/live-feed";
import { profileService } from "@/modules/users/profile.service";
import { LiveBoard } from "./live-board";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Live" };

const LIVE_SPORTS = [
  { key: "football", label: "Football" },
  { key: "basketball", label: "Basketball" },
  { key: "tennis", label: "Tennis" },
  { key: "table-tennis", label: "Table Tennis" },
  { key: "esports", label: "Esports" },
] as const;

type LiveSportKey = (typeof LIVE_SPORTS)[number]["key"];

function resolveSport(raw?: string): LiveSportKey {
  const match = LIVE_SPORTS.find((s) => s.key === raw);
  return match ? match.key : "football";
}

export default async function LivePage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string }>;
}) {
  const params = await searchParams;
  const activeSport = resolveSport(params.sport);
  const activeLabel = LIVE_SPORTS.find((s) => s.key === activeSport)?.label ?? "Football";

  const session = await getServerSession(authOptions);

  const [snapshot, preferences] = await Promise.all([
    liveSnapshot(activeSport).catch((error: unknown) => {
      console.error("[live] snapshot unavailable", error);
      return { version: "0-0", events: [] } as LiveSnapshot;
    }),
    session?.user
      ? profileService.preferences(session.user.id).catch(() => null)
      : Promise.resolve(null),
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
        {LIVE_SPORTS.map((sport) => (
          <Link
            key={sport.key}
            href={sport.key === "football" ? "/live" : `/live?sport=${sport.key}`}
            className="sb-chip"
            aria-current={activeSport === sport.key ? "true" : undefined}
          >
            {sport.label}
          </Link>
        ))}
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
