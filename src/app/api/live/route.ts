import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { liveSnapshot, liveVersion } from "@/modules/odds/live-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  sport: z.string().regex(/^[a-z0-9-]{2,40}$/).default("football"),
});

/**
 * The live board.
 *
 * Conditional GET: the client sends the cursor it last saw as `If-None-Match`,
 * and an unchanged board returns 304 with no body. In the steady state — which
 * is most of the time, since a price changes far less often than a client
 * asks — this costs one short request and no payload.
 *
 * See modules/odds/live-feed.ts for why this polls rather than pushing, and
 * where to swap in a push transport if the deployment target changes.
 */
export const GET = publicRoute(
  "browse",
  RATE_RULES.browse,
  async ({ request }: RouteContext) => {
    const url = new URL(request.url);
    const { sport } = querySchema.parse({
      sport: url.searchParams.get("sport") ?? undefined,
    });

    /*
     * The version is computed FIRST, on its own, so an unchanged board never
     * pays for the full snapshot query. That is the entire point of the
     * conditional request — checking by building the answer and throwing it
     * away would save the bandwidth and none of the work.
     */
    const version = await liveVersion(sport);
    const etag = `W/"${version}"`;

    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { etag, "cache-control": "no-cache" },
      });
    }

    const snapshot = await liveSnapshot(sport);

    return NextResponse.json(snapshot, {
      headers: {
        etag,
        // `no-cache` means revalidate, NOT "do not store": the client should
        // ask every time, and asking is cheap because of the 304 above. A
        // cached odds board that skipped revalidation would show stale prices,
        // which is the one thing a betting client must never do.
        "cache-control": "no-cache",
      },
    });
  },
);
