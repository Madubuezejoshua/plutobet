import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Virtual sports.
 *
 * A virtual round is an ORDINARY sportsbook event with a schedule attached.
 * Placement, exposure, cash-out, settlement and the ledger all treat it
 * exactly like a real fixture, because structurally it is one — the
 * differences are that the timetable is synthetic and the result comes from a
 * certified RNG rather than a stadium.
 *
 * That reuse is deliberate. A parallel `virtual_bets` table with its own
 * settlement would be a second, less-tested implementation of the most
 * dangerous code in the product, and the first place a discrepancy would
 * appear is somebody's balance.
 *
 * WHAT WE DO NOT DO
 * Generate outcomes. Virtual results come from the provider's certified RNG,
 * for the same reason casino outcomes do: a platform that generates the
 * results it pays out on cannot prove it did so fairly, and the master build
 * rules forbid it outright.
 */

export interface VirtualRound {
  id: string;
  eventId: string;
  discipline: string;
  roundNumber: number;
  scheduledAt: Date;
  settledAt: Date | null;
  fixture: string;
  status: string;
}

export class VirtualsService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /** The next rounds for one discipline, soonest first. */
  async upcoming(discipline: string, limit = 12): Promise<VirtualRound[]> {
    const rows = await db.execute<{
      id: string;
      event_id: string;
      discipline: string;
      round_number: number;
      scheduled_at: Date;
      settled_at: Date | null;
      home: string;
      away: string;
      status: string;
    }>(sql`
      SELECT vr.id, vr.event_id, vr.discipline, vr.round_number,
             vr.scheduled_at, vr.settled_at, e.home, e.away, e.status::text AS status
      FROM virtual_rounds vr
      JOIN events e ON e.id = vr.event_id
      WHERE vr.discipline = ${discipline}
        AND vr.settled_at IS NULL
        AND vr.scheduled_at > now() - INTERVAL '5 minutes'
      ORDER BY vr.scheduled_at ASC
      LIMIT ${Math.min(limit, 50)}
    `);

    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      discipline: row.discipline,
      roundNumber: Number(row.round_number),
      scheduledAt: new Date(row.scheduled_at),
      settledAt: row.settled_at ? new Date(row.settled_at) : null,
      fixture: `${row.home} v ${row.away}`,
      status: row.status,
    }));
  }

  /** Recently completed rounds, for the results strip. */
  async recentResults(discipline: string, limit = 10): Promise<
    { roundNumber: number; fixture: string; outcome: unknown; settledAt: Date }[]
  > {
    const rows = await db.execute<{
      round_number: number;
      home: string;
      away: string;
      outcome: unknown;
      settled_at: Date;
    }>(sql`
      SELECT vr.round_number, e.home, e.away, vr.outcome, vr.settled_at
      FROM virtual_rounds vr
      JOIN events e ON e.id = vr.event_id
      WHERE vr.discipline = ${discipline} AND vr.settled_at IS NOT NULL
      ORDER BY vr.settled_at DESC
      LIMIT ${Math.min(limit, 50)}
    `);

    return rows.map((row) => ({
      roundNumber: Number(row.round_number),
      fixture: `${row.home} v ${row.away}`,
      outcome: row.outcome,
      settledAt: new Date(row.settled_at),
    }));
  }

  /** Disciplines with rounds scheduled. */
  async disciplines(): Promise<{ key: string; name: string; upcoming: number }[]> {
    const rows = await db.execute<{ key: string; name: string; n: number }>(sql`
      SELECT s.key, s.name, count(vr.id)::int AS n
      FROM sports s
      LEFT JOIN virtual_rounds vr
        ON vr.discipline = s.key AND vr.settled_at IS NULL AND vr.scheduled_at > now()
      WHERE s.key LIKE 'virtual-%'
      GROUP BY s.key, s.name, s.display_order
      HAVING count(vr.id) > 0
      ORDER BY s.display_order
    `);
    return rows.map((row) => ({ key: row.key, name: row.name, upcoming: Number(row.n) }));
  }

  /**
   * Publishes a provider outcome and hands settlement over to the sportsbook.
   *
   * Writes the result into `event_results` in the SAME shape a real fixture
   * uses, so the existing settlement engine resolves the bets with no
   * knowledge that this was virtual. That is the whole point of modelling
   * rounds as events.
   */
  async publishOutcome(params: {
    provider: string;
    providerRoundId: string;
    homeScore: number;
    awayScore: number;
    raw: Record<string, unknown>;
  }): Promise<{ eventId: string; alreadyPublished: boolean }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [round] = await tx.execute<{
        id: string;
        event_id: string;
        settled_at: Date | null;
      }>(sql`
        SELECT id, event_id, settled_at FROM virtual_rounds
        WHERE provider = ${params.provider} AND provider_round_id = ${params.providerRoundId}
        FOR UPDATE
      `);
      if (!round) throw new Error(`unknown virtual round ${params.providerRoundId}`);

      // A replayed delivery must not republish. The trigger would refuse it
      // anyway; returning early makes the retry a success rather than an error
      // the provider keeps retrying.
      if (round.settled_at) {
        return { eventId: round.event_id, alreadyPublished: true };
      }

      await tx.execute(sql`
        UPDATE virtual_rounds
        SET outcome = ${JSON.stringify(params.raw)}::jsonb, settled_at = now()
        WHERE id = ${round.id}::uuid
      `);

      // Identical shape to a real result, including `periods.ft` — which is
      // what settlement reads, and what makes this work at all.
      await tx.execute(sql`
        INSERT INTO event_results (event_id, status, periods, provider)
        VALUES (
          ${round.event_id}::uuid, 'FINISHED',
          ${JSON.stringify({ ft: { home: params.homeScore, away: params.awayScore } })}::jsonb,
          ${params.provider}
        )
      `);

      await tx.execute(sql`
        UPDATE events SET status = 'SETTLED', updated_at = now()
        WHERE id = ${round.event_id}::uuid
      `);

      return { eventId: round.event_id, alreadyPublished: false };
    });
  }
}

export const virtualsService = new VirtualsService();
