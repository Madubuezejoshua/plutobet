import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";
import { getEventView } from "@/modules/odds/odds.service";
import { PageShell } from "@/components/sportsbook/page-shell";
import { BetslipPanel } from "@/components/sportsbook/betslip-panel";
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

async function balanceFor(userId: string): Promise<string | null> {
  try {
    const walletId = await walletForUser(userId);
    if (!walletId) return null;
    return (await walletService.getBalance(walletId)).toString();
  } catch {
    return null;
  }
}

export default async function EventPage({ params }: Params) {
  const { id } = await params;

  const [session, event] = await Promise.all([
    getServerSession(authOptions),
    getEventView(id).catch((error: unknown) => {
      console.error("[event] unavailable", error);
      return null;
    }),
  ]);

  if (!event) notFound();

  const signedIn = Boolean(session?.user);
  const balanceMinor = signedIn ? await balanceFor(session!.user.id) : null;
  const kickoff = new Date(event.startsAt);
  const live = event.status === "LIVE";

  return (
    <PageShell
      width="wide"
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
              timeZone: "Africa/Lagos",
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
      <div className="sb-eventgrid">
        <div>
          <EventMarkets event={event} />

          <p className="sb-xs sb-muted" style={{ marginTop: "var(--sb-4)" }}>
            Showing Home, Draw, and Away match result prices. A price can change or be
            withdrawn at any time; your bet is settled at the price confirmed when it is accepted.
          </p>
        </div>

        <aside className="sb-slipcol">
          <BetslipPanel signedIn={signedIn} balanceMinor={balanceMinor} />
        </aside>
      </div>
    </PageShell>
  );
}
