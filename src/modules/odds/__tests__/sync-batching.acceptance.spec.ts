import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeWalletTestContexts,
  createWalletTestContext,
  type WalletTestContext,
} from "@/modules/wallet/__tests__/helpers";
import { OddsSyncService } from "../sync.service";
import type { EventResult, OddsProvider, OddsSnapshot, SportEvent } from "../provider";

/**
 * Batched fixture ingestion: correctness first, speed second.
 *
 * `syncFixtures` upserted one row per round trip. The pooled client is
 * `max: 1` by design, so application-level concurrency would only queue on a
 * single connection — the only lever that helps is fewer round trips.
 *
 * NOTE ON TEST DATA: names here stay within WIN1252. The embedded Postgres
 * used by the suite runs a WIN1252 client encoding on Windows, so a character
 * outside it (Turkish ş, for instance) fails to send and the row is rejected —
 * an environment limit, not a product one. Production Neon is UTF8 and
 * round-trips those names correctly, verified directly. Accented Latin names
 * still exercise the normalisation path.
 *
 * These tests pin the properties batching could plausibly break: idempotency,
 * duplicate prevention, and not losing an entire chunk to one bad row. They
 * deliberately assert NO wall-clock timing — a threshold measured on one
 * machine is a test that fails on somebody else's laptop for no reason.
 * Timings live in `scripts/bench-sync-fixtures.ts`, which is reproducible.
 */

const ctx: WalletTestContext = createWalletTestContext();

afterAll(async () => {
  await closeWalletTestContexts([ctx]);
});

function fixtures(providerName: string, count: number): SportEvent[] {
  const leagues = ["England - Premier League", "España - Segunda", "España - LaLiga"];
  const clubs = ["Arsenal", "CD O´Higgins", "Bayern München", "Atlético Madrid", "Chelsea"];
  return Array.from({ length: count }, (_, i) => ({
    eventId: `${providerName}-evt-${i}`,
    sport: "football",
    league: leagues[i % leagues.length]!,
    home: clubs[i % clubs.length]!,
    away: clubs[(i + 2) % clubs.length]!,
    startsAt: new Date(Date.now() + (i + 1) * 60 * 60_000),
    status: "PENDING" as const,
  }));
}

function stub(providerName: string, events: SportEvent[]) {
  let listCalls = 0;
  const impl: OddsProvider = {
    name: providerName,
    async listEvents() {
      listCalls += 1;
      return events;
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
    async getResults() {
      return [] as EventResult[];
    },
  };
  return { impl, calls: () => listCalls };
}

function service(impl: OddsProvider) {
  return new OddsSyncService(impl, { sport: "football", bookmakers: ["Bet365", "1xbet"] });
}

async function eventCount(providerName: string): Promise<number> {
  const [row] = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM events WHERE provider = ${providerName}
  `);
  return Number(row?.n ?? 0);
}

describe("batched fixture ingestion", () => {
  it("persists every event in a batch larger than one chunk", async () => {
    const name = `batch-${randomUUID().slice(0, 8)}`;
    const { impl } = stub(name, fixtures(name, 120));

    const result = await service(impl).syncFixtures();

    // 120 crosses the 50-row chunk boundary, so this also proves the loop
    // advances correctly rather than re-sending the first chunk.
    expect(result.upserted).toBe(120);
    expect(result.failed).toBe(0);
    expect(await eventCount(name)).toBe(120);
  });

  it("is idempotent — a second identical run adds nothing", async () => {
    const name = `idem-${randomUUID().slice(0, 8)}`;
    const events = fixtures(name, 60);
    const { impl } = stub(name, events);
    const sync = service(impl);

    await sync.syncFixtures();
    const afterFirst = await eventCount(name);
    await sync.syncFixtures();
    const afterSecond = await eventCount(name);

    // ON CONFLICT DO UPDATE, not DO NOTHING: a re-run must refresh kickoff and
    // status without creating a second row.
    expect(afterFirst).toBe(60);
    expect(afterSecond).toBe(60);
  });

  it("updates a changed kickoff rather than inserting a duplicate", async () => {
    const name = `update-${randomUUID().slice(0, 8)}`;
    const first = fixtures(name, 5);
    await service(stub(name, first).impl).syncFixtures();

    const moved = first.map((e) => ({
      ...e,
      startsAt: new Date(e.startsAt.getTime() + 90 * 60_000),
    }));
    await service(stub(name, moved).impl).syncFixtures();

    expect(await eventCount(name)).toBe(5);
    const [row] = await ctx.database.execute<{ starts_at: Date }>(sql`
      SELECT starts_at FROM events
      WHERE provider = ${name} AND provider_event_id = ${first[0]!.eventId}
    `);
    expect(new Date(row!.starts_at).getTime()).toBe(moved[0]!.startsAt.getTime());
  });

  it("creates no duplicate provider_event_id", async () => {
    const name = `dupe-${randomUUID().slice(0, 8)}`;
    const events = fixtures(name, 40);
    const sync = service(stub(name, events).impl);

    await sync.syncFixtures();
    await sync.syncFixtures();
    await sync.syncFixtures();

    const [row] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT provider_event_id FROM events WHERE provider = ${name}
        GROUP BY provider_event_id HAVING count(*) > 1
      ) d
    `);
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it("still makes exactly ONE provider call regardless of batch size", async () => {
    const name = `calls-${randomUUID().slice(0, 8)}`;
    const { impl, calls } = stub(name, fixtures(name, 200));

    await service(impl).syncFixtures();

    // Batching must not become "a request per chunk". The bounded 14-day call
    // is the whole reason the free tier survives real traffic.
    expect(calls()).toBe(1);
  });

  it("preserves non-ASCII team keys through batching", async () => {
    const name = `keys-${randomUUID().slice(0, 8)}`;
    await service(stub(name, fixtures(name, 20)).impl).syncFixtures();

    // The dataset contains CD O´Higgins, Bayern München and Atlético Madrid. Every
    // stored key must satisfy the column constraint, or classification silently
    // fails for those clubs.
    const rows = await ctx.database.execute<{ key: string }>(sql`SELECT key FROM teams`);
    for (const row of rows) {
      expect(row.key).toMatch(/^[a-z0-9-]{1,120}$/);
    }
  });

  it("reports a provider failure rather than returning an empty success", async () => {
    const name = `fail-${randomUUID().slice(0, 8)}`;
    const failing: OddsProvider = {
      ...stub(name, []).impl,
      async listEvents() {
        throw new Error("provider exploded");
      },
    };
    await expect(service(failing).syncFixtures()).rejects.toThrow(/provider exploded/);
  });

  it("does not lose a whole chunk to one unusable row", async () => {
    const name = `partial-${randomUUID().slice(0, 8)}`;
    const events = fixtures(name, 10);
    // An unrepresentable timestamp. The other nine must still land and the
    // failure must be counted — dropping ten fixtures because of one is the
    // loss nobody notices until a customer cannot find their match.
    //
    // An empty provider_event_id was tried first and did NOT work: no
    // constraint forbids it, so all ten succeeded and the test proved nothing.
    events[4] = { ...events[4]!, startsAt: new Date("not-a-date") };

    const result = await service(stub(name, events).impl).syncFixtures();

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.upserted).toBe(9);
    expect(await eventCount(name)).toBe(9);
  });
});
