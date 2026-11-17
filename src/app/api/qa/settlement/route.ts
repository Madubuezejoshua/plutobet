import { NextResponse } from "next/server";
import { z } from "zod";
import { qaMethodNotAllowed, qaRoute } from "@/lib/api/qa-route";
import { driveSettlement } from "@/modules/qa/settlement-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Makes a match finish, and lets the registered background functions do the
 * rest.
 *
 * This is the missing trigger. A browser can place a bet and can read what the
 * product says about it afterwards; what it cannot do is make ninety minutes
 * pass and a result arrive. Everything downstream of that — the transactional
 * outbox, the dispatcher, `settleEvent`, `settleBet`, the payout, the exposure
 * release, the market closure — is production code reached the production way.
 * See `src/modules/qa/settlement-drive.ts` for exactly what is substituted (the
 * provider's answer, and nothing else) and what is written directly (an event's
 * kickoff time, and nothing else).
 *
 * Deliberately returns COUNTS rather than outcomes. The test must read the
 * result from the customer's screen and the administrator's screen, which is
 * the claim being made; a route that reported "WON" would let a journey pass by
 * believing this endpoint instead of the product.
 */

const schema = z.object({
  results: z
    .array(
      z.object({
        providerEventId: z.string().min(1),
        eventId: z.string().uuid(),
        ft: z.object({ home: z.number().int().min(0), away: z.number().int().min(0) }).optional(),
        cancelled: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(10),
  sweep: z.boolean().optional(),
});

export const POST = qaRoute("settlement", async (request) => {
  const body = schema.parse(await request.json());

  const outcome = await driveSettlement({
    results: body.results.map((r) => ({
      providerEventId: r.providerEventId,
      eventId: r.eventId,
      result: { ft: r.ft, cancelled: r.cancelled },
    })),
    sweep: body.sweep,
  });

  return NextResponse.json(outcome);
});

/*
 * The verbs this route does not implement, answered through the SAME gate.
 * Without them Next replies 405 before any handler runs, and a 405 next to a
 * 404 tells a stranger the path exists — see `qaMethodNotAllowed`.
 */
export const GET = qaMethodNotAllowed("settlement");
export const PUT = qaMethodNotAllowed("settlement");
export const PATCH = qaMethodNotAllowed("settlement");
export const DELETE = qaMethodNotAllowed("settlement");
