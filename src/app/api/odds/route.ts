import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { listUpcoming } from "@/modules/odds/odds.service";

export const runtime = "nodejs";
// Never statically cached: prices move, and a cached page would quote a stale
// one to a user who is about to bet on it.
export const dynamic = "force-dynamic";

const querySchema = z.object({
  sport: z.string().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Public odds listing.
 *
 * Reads only from Postgres via OddsService, which has no reference to the
 * provider — that is the Phase 2 guarantee: browsing traffic can never spend
 * upstream API budget, however much of it there is.
 */
export const GET = publicRoute(
  "browse",
  RATE_RULES.browse,
  async ({ request }: RouteContext) => {
    const url = new URL(request.url);
    const query = querySchema.parse({
      sport: url.searchParams.get("sport") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    const events = await listUpcoming({ sport: query.sport, limit: query.limit });
    return NextResponse.json({ events });
  },
);
