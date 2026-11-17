import { NextResponse } from "next/server";
import { z } from "zod";
import { authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { responsibleService } from "@/modules/responsible/responsible.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limitSchema = z.object({
  type: z.enum(["DEPOSIT", "LOSS", "WAGER"]),
  periodDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  amountMinor: z
    .string()
    .regex(/^\d+$/, "amount must be a whole number of kobo")
    .transform((value) => BigInt(value)),
});

const coolOffSchema = z.object({
  action: z.literal("COOL_OFF"),
  days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]),
});

const excludeSchema = z.object({
  action: z.literal("SELF_EXCLUDE"),
  /** Omitted means permanent. */
  months: z.union([z.literal(6), z.literal(12), z.literal(60)]).optional(),
});

const bodySchema = z.union([
  limitSchema.extend({ action: z.literal("SET_LIMIT") }),
  coolOffSchema,
  excludeSchema,
]);

/**
 * Player-set responsible gambling controls.
 *
 * Every action here is one the player takes on themselves, so none of them
 * needs an admin. The asymmetry that matters is in the service: tightening a
 * limit applies immediately, loosening waits 24 hours, and self-exclusion
 * cannot be undone from this endpoint at all.
 */
export const POST = authedRoute(
  "wallet",
  RATE_RULES.wallet,
  async ({ request, userId }: AuthedRouteContext) => {
    const body = bodySchema.parse(await request.json());

    if (body.action === "SET_LIMIT") {
      const result = await responsibleService.setLimit({
        userId,
        type: body.type,
        periodDays: body.periodDays,
        amountMinor: body.amountMinor,
      });

      return NextResponse.json({
        type: body.type,
        amountMinor: money(body.amountMinor),
        effectiveFrom: result.effectiveFrom.toISOString(),
        // The client must show this: a player who thinks a raised limit is
        // live, and finds it is not, has been misled at exactly the wrong
        // moment.
        deferred: result.deferred,
      });
    }

    if (body.action === "COOL_OFF") {
      const until = new Date(Date.now() + body.days * 24 * 60 * 60_000);
      await responsibleService.startCoolOff(userId, until);
      return NextResponse.json({ coolOffUntil: until.toISOString() });
    }

    // Self-exclusion. Registered against every verified identity on the
    // account so it survives re-registration under a new email, and the
    // account is closed in the same transaction.
    const until = body.months
      ? new Date(Date.now() + body.months * 30 * 24 * 60 * 60_000)
      : null;
    const result = await responsibleService.selfExclude({
      userId,
      until,
      reason: "player request",
    });

    return NextResponse.json({
      selfExcluded: true,
      until: until?.toISOString() ?? null,
      identitiesRegistered: result.identitiesRegistered,
    });
  },
);
