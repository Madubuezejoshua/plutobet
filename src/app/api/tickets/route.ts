import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TicketRow = {
  id: string;
  status: string;
  stake_minor: string;
  total_odds_decimal: string;
  potential_return_minor: string;
  cashout_value_minor: string | null;
  placed_at: Date;
};

type LegRow = {
  fixture: string;
  league: string;
  sport: string;
  market_key: string;
  selection_label: string;
  odds_decimal: string;
  status: string;
  starts_at: Date;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f]{8,32}$/i;

function computeSettledReturn(ticket: TicketRow): string | null {
  switch (ticket.status) {
    case "WON":
      return ticket.potential_return_minor;
    case "VOID":
      return ticket.stake_minor;
    case "CASHED_OUT":
      return ticket.cashout_value_minor ?? null;
    case "LOST":
      return "0";
    default:
      return null;
  }
}

/**
 * Public, read-only Ticket Verification ("Check Ticket") endpoint.
 *
 * Accepts either a full bet UUID or an 8+ hex prefix (matching the short
 * reference printed on bet confirmations) and returns ONLY non-PII ticket
 * summary + leg outcomes. Never exposes user IDs, phone numbers, emails, or
 * wallet balances.
 */
export const GET = publicRoute(
  "browse",
  RATE_RULES.browse,
  async ({ request }: RouteContext) => {
    const { searchParams } = new URL(request.url);
    const rawRef = (searchParams.get("ref") ?? "").trim().replace(/^#/, "");

    if (rawRef.length < 8 || rawRef.length > 40) {
      return NextResponse.json(
        { error: "Enter at least the first 8 characters of your ticket reference." },
        { status: 400 },
      );
    }

    const normalized = rawRef.toLowerCase();
    const isUuid = UUID_RE.test(normalized);
    const compactHex = normalized.replace(/-/g, "");

    if (!isUuid && !PREFIX_RE.test(compactHex)) {
      return NextResponse.json(
        { error: "Ticket references use hexadecimal characters (e.g. a1b2c3d4)." },
        { status: 400 },
      );
    }

    try {
      const matches = isUuid
        ? await db.execute<TicketRow>(sql`
            SELECT
              id::text AS id,
              status::text AS status,
              stake_minor::text AS stake_minor,
              total_odds_decimal::text AS total_odds_decimal,
              potential_return_minor::text AS potential_return_minor,
              cashout_value_minor::text AS cashout_value_minor,
              placed_at
            FROM bets
            WHERE id = ${normalized}::uuid
            LIMIT 2
          `)
        : await db.execute<TicketRow>(sql`
            SELECT
              id::text AS id,
              status::text AS status,
              stake_minor::text AS stake_minor,
              total_odds_decimal::text AS total_odds_decimal,
              potential_return_minor::text AS potential_return_minor,
              cashout_value_minor::text AS cashout_value_minor,
              placed_at
            FROM bets
            WHERE replace(id::text, '-', '') LIKE ${`${compactHex}%`}
            ORDER BY placed_at DESC
            LIMIT 2
          `);

      if (matches.length === 0) {
        return NextResponse.json(
          { error: "No bet ticket found for that reference." },
          { status: 404 },
        );
      }

      if (matches.length > 1) {
        return NextResponse.json(
          { error: "Multiple tickets match that short prefix. Enter a few more characters." },
          { status: 409 },
        );
      }

      const ticket = matches[0]!;
      const legs = await db.execute<LegRow>(sql`
        SELECT
          (e.home || ' v ' || e.away) AS fixture,
          e.league,
          e.sport,
          m.key::text AS market_key,
          s.label AS selection_label,
          bl.locked_odds_decimal::text AS odds_decimal,
          COALESCE(bl.result::text, 'PENDING') AS status,
          e.starts_at
        FROM bet_legs bl
        JOIN selections s ON s.id = bl.selection_id
        JOIN markets m ON m.id = s.market_id
        JOIN events e ON e.id = m.event_id
        WHERE bl.bet_id = ${ticket.id}::uuid
        ORDER BY e.starts_at ASC
      `);

      return NextResponse.json({
        ticket: {
          reference: ticket.id.slice(0, 8).toUpperCase(),
          status: ticket.status,
          stakeMinor: ticket.stake_minor,
          totalOdds: Number(ticket.total_odds_decimal),
          potentialReturnMinor: ticket.potential_return_minor,
          settledReturnMinor: computeSettledReturn(ticket),
          placedAt: new Date(ticket.placed_at).toISOString(),
          legs: legs.map((leg) => ({
            fixture: leg.fixture,
            league: leg.league,
            sport: leg.sport,
            marketKey: leg.market_key,
            selectionLabel: leg.selection_label,
            odds: Number(leg.odds_decimal),
            status: leg.status,
            startsAt: new Date(leg.starts_at).toISOString(),
          })),
        },
      });
    } catch (error) {
      console.error("[tickets] verification lookup failed", error);
      return NextResponse.json(
        { error: "Could not verify ticket right now. Please try again." },
        { status: 500 },
      );
    }
  },
);
