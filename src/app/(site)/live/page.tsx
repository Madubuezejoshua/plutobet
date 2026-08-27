import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { liveSnapshot, type LiveSnapshot } from "@/modules/odds/live-feed";
import { profileService } from "@/modules/users/profile.service";
import { LiveBoard } from "./live-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "Live" };

export default async function LivePage() {
  const session = await getServerSession(authOptions);

  const [snapshot, preferences] = await Promise.all([
    // The first paint is server-rendered so the board is readable before any
    // JavaScript runs; the client takes over polling from that cursor.
    liveSnapshot("football").catch((error: unknown) => {
      console.error("[live] snapshot unavailable", error);
      return { version: "0-0", events: [] } as LiveSnapshot;
    }),
    session?.user
      ? profileService.preferences(session.user.id).catch(() => null)
      : Promise.resolve(null),
  ]);

  const inPlay = snapshot.events.filter((event) => event.status === "LIVE").length;

  return (
    <>
      <header className="page-head">
        <h1>Live</h1>
        <p className="muted">
          {inPlay > 0
            ? `${inPlay} in play · prices refresh automatically`
            : "Nothing in play right now"}
        </p>
      </header>

      <LiveBoard snapshot={snapshot} oddsFormat={preferences?.oddsFormat ?? "DECIMAL"} />

      <p className="muted small legal" style={{ marginBottom: 40 }}>
        Live prices are shown for information. In-play betting opens once a real in-play feed is
        connected — a tappable price we would then refuse is worse than no price at all.
      </p>
    </>
  );
}
