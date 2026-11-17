import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeWalletTestContexts,
  createWalletTestContext,
  type WalletTestContext,
} from "@/modules/wallet/__tests__/helpers";
import { WalletService } from "@/modules/wallet/wallet.service";
import { ResultIngestionService } from "../ingestion.service";
import { SettlementService } from "../settlement.service";
import type { EventResult, OddsProvider, OddsSnapshot, SportEvent } from "@/modules/odds/provider";

/**
 * One unresolvable fixture must not stop the sportsbook settling.
 *
 * FOUND BY RUNNING IT, NOT BY READING IT. The very first time the scheduler was
 * ever actually started against the real provider, the heartbeat recorded:
 *
 *   odds-api.io /events/72546036 -> 404 {"error":"Event not found"}
 *
 * `getResults` fetched each due event in a loop, so that single 404 threw out
 * of the whole batch. Twenty events returned nothing, the poll failed, and no
 * bet on any event could settle — every minute, indefinitely, because the
 * offending event sorted to the head of the queue on each tick.
 *
 * There was a second half to it. Even once the 404 stopped being fatal, an
 * event the provider says nothing about never got deferred, so it stayed
 * eligible and was re-fetched forever: the starvation fix undone by the case it
 * did not anticipate.
 *
 * These tests pin both halves, and the boundary between them: a 404 is about
 * ONE event and must be survivable, while a rate limit is about the whole run
 * and must still stop it.
 */

const ctx: WalletTestContext = createWalletTestContext();
const wallet = new WalletService(ctx.database);

afterAll(async () => {
  await closeWalletTestContexts([ctx]);
});

function provider(
  name: string,
  getResults: (ids: string[]) => Promise<EventResult[]>,
): OddsProvider {
  return {
    name,
    async listEvents() {
      return [] as SportEvent[];
    },
    async listLiveEvents() {
      return [] as SportEvent[];
    },
    async getOdds() {
      return [] as OddsSnapshot[];
    },
    async getUpdatedSince() {
      return [] as OddsSnapshot[];
    },
    getResults,
  };
}

/** Events kicked off long enough ago to be due for a result poll. */
async function seedDueEvents(providerName: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const [row] = await ctx.database.execute<{ id: string }>(sql`
      INSERT INTO events (provider, provider_event_id, sport, league, home, away, starts_at, status)
      VALUES (
        ${providerName}, ${`${providerName}-evt-${i}`}, 'football', 'Test - League',
        ${`Home ${i}`}, ${`Away ${i}`}, now() - interval '5 hours', 'PENDING'
      )
      RETURNING id
    `);
    ids.push(row!.id);
  }
  return ids;
}

function service(impl: OddsProvider): ResultIngestionService {
  return new ResultIngestionService(impl, new SettlementService(wallet), wallet);
}

async function pollState(eventId: string) {
  const [row] = await ctx.database.execute<{
    attempts: number;
    last: Date | null;
    next: Date | null;
    status: string;
  }>(sql`
    SELECT result_poll_attempts AS attempts, result_last_polled_at AS last,
           result_next_poll_at AS next, status::text
    FROM events WHERE id = ${eventId}::uuid
  `);
  return row!;
}

describe("result polling survives one unresolvable fixture", () => {
  it("settles the other events when the provider has forgotten one", async () => {
    const name = `notfound-${randomUUID().slice(0, 8)}`;
    const ids = await seedDueEvents(name, 3);

    // The middle event is the one the provider no longer knows. The adapter
    // skips it, so it is simply absent from the returned list.
    const impl = provider(name, async (requested) =>
      requested
        .filter((id) => !id.endsWith("-evt-1"))
        .map((id) => ({
          eventId: id,
          status: "SETTLED" as const,
          home: 1,
          away: 0,
          periods: { ft: { home: 1, away: 0 } },
        })),
    );

    const finished = await service(impl).pollFinishedEvents();

    // Two of three settle. Before the fix this was zero.
    expect(finished).toHaveLength(2);
    expect(finished.map((f) => f.eventId).sort()).toEqual([ids[0]!, ids[2]!].sort());
  });

  it("defers the forgotten event instead of re-fetching it every tick", async () => {
    const name = `defer-${randomUUID().slice(0, 8)}`;
    const ids = await seedDueEvents(name, 2);
    let calls = 0;

    const impl = provider(name, async (requested) => {
      calls += 1;
      return requested
        .filter((id) => !id.endsWith("-evt-0"))
        .map((id) => ({
          eventId: id,
          status: "SETTLED" as const,
          home: 0,
          away: 0,
          periods: { ft: { home: 0, away: 0 } },
        }));
    });

    const ingestion = service(impl);
    await ingestion.pollFinishedEvents();

    const deferred = await pollState(ids[0]!);
    // Backed off, and NOT resolved: a provider briefly missing data must never
    // become a permanently unsettled bet.
    expect(deferred.attempts).toBe(1);
    expect(deferred.next).not.toBeNull();
    expect(new Date(deferred.next!).getTime()).toBeGreaterThan(Date.now());
    expect(deferred.status).toBe("PENDING");

    // The next tick must not ask about it again, because it is not yet due.
    await ingestion.pollFinishedEvents();
    expect(calls).toBe(1);
  });

  it("still stops the whole run on a rate limit", async () => {
    const name = `ratelimit-${randomUUID().slice(0, 8)}`;
    await seedDueEvents(name, 2);

    const impl = provider(name, async () => {
      throw new Error("odds-api.io rate limited (429) — budget guard drifted");
    });

    // The boundary that matters: a 404 is about one event, a 429 is about the
    // run. Swallowing this one would spend tomorrow's quota too.
    await expect(service(impl).pollFinishedEvents()).rejects.toThrow(/rate limited/);
  });

  it("backs off progressively rather than at a fixed interval", async () => {
    const name = `backoff-${randomUUID().slice(0, 8)}`;
    const [eventId] = await seedDueEvents(name, 1);
    const impl = provider(name, async () => []);
    const ingestion = service(impl);

    await ingestion.pollFinishedEvents();
    const first = await pollState(eventId!);

    // Make it due again so a second attempt is possible without waiting.
    await ctx.database.execute(sql`
      UPDATE events SET result_next_poll_at = now() - interval '1 minute'
      WHERE id = ${eventId}::uuid
    `);
    await ingestion.pollFinishedEvents();
    const second = await pollState(eventId!);

    expect(second.attempts).toBe(2);
    const firstGap = new Date(first.next!).getTime() - new Date(first.last!).getTime();
    const secondGap = new Date(second.next!).getTime() - new Date(second.last!).getTime();
    // Doubling, so a fixture the provider never scores drifts towards the daily
    // cap instead of occupying a slot on every cycle.
    expect(secondGap).toBeGreaterThan(firstGap);
  });

  it("does not defer an event it successfully settled", async () => {
    const name = `settled-${randomUUID().slice(0, 8)}`;
    const [eventId] = await seedDueEvents(name, 1);
    const impl = provider(name, async (requested) =>
      requested.map((id) => ({
        eventId: id,
        status: "SETTLED" as const,
        home: 2,
        away: 1,
        periods: { ft: { home: 2, away: 1 } },
      })),
    );

    await service(impl).pollFinishedEvents();
    const state = await pollState(eventId!);

    // A settled event must not be given a future poll date by the catch-all
    // deferral loop — it is finished, not waiting.
    expect(state.attempts).toBe(0);
    expect(state.status).toBe("SETTLED");
  });
});
