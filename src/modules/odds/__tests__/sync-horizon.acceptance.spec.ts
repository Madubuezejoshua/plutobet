import { describe, expect, it, vi } from "vitest";
import { OddsSyncService } from "../sync.service";
import type {
  EventResult,
  OddsProvider,
  OddsSnapshot,
  SportEvent,
} from "../provider";

/**
 * Regression tests for two defects that each made the sportsbook unusable in a
 * different way, and neither of which raised an error anybody saw.
 *
 * 1. `syncFixtures` never passed a `to` bound, despite its own docstring
 *    promising "one call covers the next 14 days". The provider returned its
 *    whole catalogue — ~5000 football events, of which only ~775 had not
 *    finished — and each row costs an upsert plus taxonomy work. A job
 *    scheduled every 30 minutes ran for hours and never completed.
 *
 * 2. `syncOddsDelta` never passed a `bookmaker`, which `/odds/updated`
 *    requires. Every run since the job was written threw `400 Missing
 *    bookmaker parameter` before reaching `persist()`, so the platform stored
 *    real fixtures and ZERO prices.
 *
 * These use a recording fake provider. Nothing here needs a real key — the
 * live check lives in `provider-contract.acceptance.spec.ts` behind
 * `ODDS_LIVE_CONTRACT`.
 */

const DAY = 24 * 60 * 60_000;

function event(overrides: Partial<SportEvent> = {}): SportEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sport: "football",
    league: "Test League",
    home: "Home FC",
    away: "Away FC",
    startsAt: new Date(Date.now() + 2 * DAY),
    status: "PENDING",
    ...overrides,
  };
}

/** Records exactly what the service asked the provider for. */
function recordingProvider(events: SportEvent[]) {
  const calls: {
    listEvents: { sport: string; to?: Date }[];
    updatedSince: { sport?: string; bookmaker?: string }[];
    getOdds: { ids: string[]; bookmakers: string[] }[];
  } = { listEvents: [], updatedSince: [], getOdds: [] };

  const provider: OddsProvider = {
    name: "recording-provider",
    async listEvents(sport, opts) {
      calls.listEvents.push({ sport, to: opts?.to });
      return events;
    },
    async listLiveEvents() {
      return [];
    },
    async getOdds(ids, bookmakers) {
      calls.getOdds.push({ ids, bookmakers });
      return [] as OddsSnapshot[];
    },
    async getUpdatedSince(_since, opts) {
      calls.updatedSince.push({ sport: opts.sport, bookmaker: opts.bookmaker });
      return [] as OddsSnapshot[];
    },
    async getResults() {
      return [] as EventResult[];
    },
  };

  return { provider, calls };
}

function service(provider: OddsProvider, bookmakers = ["1xbet", "bet365"]) {
  return new OddsSyncService(provider, { sport: "football", bookmakers });
}

describe("odds sync — fixture horizon", () => {
  it("asks the provider for a BOUNDED window, not the whole catalogue", async () => {
    const { provider, calls } = recordingProvider([event()]);

    await service(provider).syncFixtures();

    expect(calls.listEvents).toHaveLength(1);
    const { to } = calls.listEvents[0]!;
    // The bug: `to` was undefined, so the provider returned everything it had.
    expect(to, "syncFixtures did not bound its request").toBeDefined();
  });

  it("bounds that window to the documented 14 days", async () => {
    const { provider, calls } = recordingProvider([event()]);
    const before = Date.now();

    await service(provider).syncFixtures();

    const to = calls.listEvents[0]!.to!.getTime();
    const days = (to - before) / DAY;
    // Generous bounds: the point is that it is ~14 days and not unbounded,
    // not that the arithmetic lands on a particular millisecond.
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it("skips fixtures that have already finished", async () => {
    // Only PENDING and LIVE can be bet on. Upserting settled and cancelled
    // history is pure cost: it was the bulk of the 5000-event catalogue.
    const { provider } = recordingProvider([
      event({ status: "PENDING" }),
      event({ status: "LIVE" }),
      event({ status: "SETTLED" }),
      event({ status: "CANCELLED" }),
      event({ status: "SETTLED" }),
    ]);

    const result = await service(provider).syncFixtures();

    expect(result.upserted).toBe(2);
  });

  it("terminates cleanly on an empty provider response", async () => {
    const { provider } = recordingProvider([]);
    await expect(service(provider).syncFixtures()).resolves.toEqual(
      expect.objectContaining({ upserted: 0 }),
    );
  });

  it("makes exactly ONE provider call — it does not paginate into the full catalogue", async () => {
    const { provider, calls } = recordingProvider(
      Array.from({ length: 50 }, () => event()),
    );

    await service(provider).syncFixtures();

    // A loop that keeps asking for the next page is how a bounded window
    // quietly becomes an unbounded one again.
    expect(calls.listEvents).toHaveLength(1);
  });

  it("surfaces a provider failure rather than reporting an empty success", async () => {
    const failing: OddsProvider = {
      ...recordingProvider([]).provider,
      async listEvents() {
        throw new Error("provider exploded");
      },
    };

    // A swallowed failure here reads exactly like "no fixtures today", which
    // is how an outage becomes an empty board nobody investigates.
    await expect(service(failing).syncFixtures()).rejects.toThrow(/provider exploded/);
  });
});

describe("odds sync — delta requires a bookmaker", () => {
  it("passes a bookmaker to /odds/updated", async () => {
    const { provider, calls } = recordingProvider([]);

    await service(provider).syncOddsDelta();

    expect(calls.updatedSince).toHaveLength(1);
    // The bug: this was undefined, the parameter was dropped from the URL, and
    // the provider answered 400 on every run for the life of the project.
    expect(
      calls.updatedSince[0]!.bookmaker,
      "syncOddsDelta sent no bookmaker — /odds/updated will answer 400",
    ).toBeTruthy();
  });

  it("uses the FIRST configured bookmaker as the canonical price", async () => {
    const { provider, calls } = recordingProvider([]);

    await service(provider, ["1xbet", "bet365"]).syncOddsDelta();

    // Order is meaningful elsewhere too — canonicalBook() resolves the same
    // way — so the delta must not disagree with the price the board shows.
    expect(calls.updatedSince[0]!.bookmaker).toBe("1xbet");
  });

  it("refuses to run with no bookmaker configured rather than sending a broken request", async () => {
    const { provider } = recordingProvider([]);

    await expect(service(provider, []).syncOddsDelta()).rejects.toThrow(
      /at least one configured bookmaker/i,
    );
  });

  it("still passes the sport alongside the bookmaker", async () => {
    const { provider, calls } = recordingProvider([]);
    await service(provider).syncOddsDelta();
    expect(calls.updatedSince[0]!.sport).toBe("football");
  });
});
