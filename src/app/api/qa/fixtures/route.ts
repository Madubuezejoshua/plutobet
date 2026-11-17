import { NextResponse } from "next/server";
import { z } from "zod";
import { qaMethodNotAllowed, qaRoute } from "@/lib/api/qa-route";
import {
  createDisposableAccount,
  createDisposableEvent,
  fundDisposableAccount,
  setMarketStatus,
  setSelectionState,
} from "@/modules/qa/fixtures.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Makes the disposable things a browser test needs and cannot make for itself.
 *
 * ONE ROUTE, SEVERAL ACTIONS, on purpose. Each of these is three lines of glue
 * over a function in `fixtures.service.ts`, and five route files would spread
 * the same 404 gate over five places to be got wrong independently. The gate is
 * `qaRoute`, applied once.
 *
 * WHAT EACH ACTION IS FOR:
 *
 *   account    an isolated account, so a test can self-exclude, take a
 *              cool-off, change a password or revoke every session without
 *              destroying the shared demo player the rest of the run needs
 *   fund       an ADJUSTMENT through the real ledger service. NOT a deposit,
 *              and never reported as one
 *   event      a private fixture with its own 1x2 market, so a settlement test
 *              is not racing another test's match
 *   selection  suspend, close or reprice — the two columns an odds feed writes
 *              every few seconds, which a review server has no feed to write
 *   market     the same, one level up
 */

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("account"),
    label: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
    password: z.string().min(12).max(72).optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    kycLevel: z.number().int().min(0).max(3).optional(),
    fundMinor: z.string().regex(/^\d+$/).optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  }),
  z.object({
    action: z.literal("fund"),
    userId: z.string().uuid(),
    amountMinor: z.string().regex(/^\d+$/),
  }),
  z.object({
    action: z.literal("event"),
    label: z.string().min(1).max(40),
    startsInHours: z.number().min(0.1).max(720).optional(),
    prices: z.tuple([z.string(), z.string(), z.string()]).optional(),
    // Only ever "review" or "football" in practice; constrained so a fixture
    // cannot be filed under a sport the board does not know about.
    sport: z.enum(["review", "football"]).optional(),
  }),
  z.object({
    action: z.literal("selection"),
    selectionId: z.string().uuid(),
    status: z.enum(["OPEN", "SUSPENDED", "SETTLED", "VOID"]).optional(),
    priceDecimal: z.string().optional(),
  }),
  z.object({
    action: z.literal("market"),
    marketId: z.string().uuid(),
    status: z.enum(["OPEN", "SUSPENDED", "SETTLED", "VOID"]),
  }),
]);

export const POST = qaRoute("fixtures", async (request) => {
  const body = schema.parse(await request.json());

  switch (body.action) {
    case "account": {
      const account = await createDisposableAccount(body);
      return NextResponse.json(account);
    }
    case "fund": {
      const balanceMinor = await fundDisposableAccount(body.userId, BigInt(body.amountMinor));
      return NextResponse.json({ balanceMinor: balanceMinor.toString() });
    }
    case "event": {
      const event = await createDisposableEvent(body);
      return NextResponse.json(event);
    }
    case "selection": {
      return NextResponse.json(await setSelectionState(body));
    }
    case "market": {
      return NextResponse.json(await setMarketStatus(body));
    }
  }
});

/*
 * The verbs this route does not implement, answered through the SAME gate.
 * Without them Next replies 405 before any handler runs, and a 405 next to a
 * 404 tells a stranger the path exists — see `qaMethodNotAllowed`.
 */
export const GET = qaMethodNotAllowed("fixtures");
export const PUT = qaMethodNotAllowed("fixtures");
export const PATCH = qaMethodNotAllowed("fixtures");
export const DELETE = qaMethodNotAllowed("fixtures");
