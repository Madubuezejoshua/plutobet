import { notFound } from "next/navigation";
import { getEventView } from "@/modules/odds/odds.service";
import { PageShell } from "@/components/sportsbook/page-shell";
import { EventMarkets } from "./event-markets";

export const dynamic = "force-dynamic";

/**
 * One fixture, with every market that is open on it.
 *
 * WHY THIS PAGE EXISTS. The board linked here from two controls on every row —
 * the statistics icon and the "+N more markets" chip — and the route did not
 * exist. Both were 404s, on the single most-used screen in the product.
 *
 * It is a read-only view over stored odds. Nothing here calls a provider,
 * prices no bet and invents no market: a market the provider is not carrying
 * is simply not listed, and a market carried without a usable price renders
 * suspended rather than as a number.
 */

interface Params {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Params) {
  const { id } = await params;
  const event = await getEventView(id).catch(() => null);
  if (!event) return { title: "Match" };
  return {
    title: `${event.home} v ${event.away}`,
    description: `Odds for ${event.home} against ${event.away} in ${event.league}.`,
  };
}

export default async function EventPage({ params }: Params) {
  const { id } = await params;

  const event = await getEventView(id).catch((error: unknown) => {
    console.error("[event] unavailable", error);
    return null;
  });

  if (!event) notFound();

  const kickoff = new Date(event.startsAt);
  const live = event.status === "LIVE";

  return (
    <PageShell
      title={`${event.home} v ${event.away}`}
      sub={
        <>
          {event.league} ·{" "}
          {live ? (
            <span className="sb-live">
              <span className="sb-live__dot" aria-hidden="true" />
              In play
            </span>
          ) : (
            kickoff.toLocaleString("en-NG", {
              weekday: "short",
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })
          )}
        </>
      }
      back={{ href: `/sports?league=${encodeURIComponent(event.league)}`, label: event.league }}
    >
      <EventMarkets event={event} />

      <p className="sb-xs sb-muted" style={{ marginTop: "var(--sb-4)" }}>
        Only markets that are currently open are listed. A price can change or be withdrawn at any
        time; your bet is settled at the price confirmed when it is accepted.
      </p>
    </PageShell>
  );
}
