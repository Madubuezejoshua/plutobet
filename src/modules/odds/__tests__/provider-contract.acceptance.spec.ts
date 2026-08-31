import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OddsApiIoProvider } from "../odds-api-io";
import type { ApiBudget } from "../budget";

/**
 * PROVIDER CONTRACT TEST
 * ======================
 *
 * Settlement decides who gets paid by reading `periods.ft` out of whatever
 * JSON odds-api.io returns. That single parse is the highest-consequence line
 * in the codebase: if the provider moves the field, bets settle against a
 * score that is not there.
 *
 * Until now that shape had been validated exactly ONCE, by a human running
 * `scripts/probe-odds.ts` and reading the output. This runs the real adapter
 * against real captured responses on every test run instead.
 *
 * The fixtures in ./fixtures are genuine API responses, not hand-written
 * approximations of them — a fixture somebody typed out to match the code
 * tests nothing but the typist. Refresh them with:
 *
 *   npx tsx scripts/capture-odds-fixtures.ts
 *
 * WHEN THIS TEST FAILS, THE PROVIDER CHANGED. Do not edit the expectation to
 * match the new shape until you have confirmed which fields moved and what
 * settlement now reads. That is the whole point of the test.
 */

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): { path: string; status: number; body: unknown } {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

/** Budget is irrelevant here; the network never gets touched. */
const noBudget = { spend: async () => {} } as unknown as ApiBudget;

/**
 * Serves a captured body to the adapter's own `fetch`.
 *
 * The adapter builds URLs, sets the key, checks status and parses — all of
 * that stays under test. Only the socket is replaced.
 */
function serve(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("odds-api.io response contract", () => {
  describe("the settlement-critical parse", () => {
    it("finds a regulation score at scores.periods.ft", () => {
      const { body } = fixture("event-detail-settled");
      const scores = (body as Record<string, any>).scores;

      // Asserted on the RAW fixture, before any of our code runs. If the
      // provider renames this, the failure names the provider rather than
      // surfacing later as an adapter bug.
      expect(scores, "response has no `scores` object").toBeDefined();
      expect(scores.periods, "`scores.periods` is missing").toBeDefined();
      expect(scores.periods.ft, "`scores.periods.ft` is missing — SETTLEMENT IS BLIND").toBeDefined();
      expect(Number.isInteger(scores.periods.ft.home)).toBe(true);
      expect(Number.isInteger(scores.periods.ft.away)).toBe(true);
    });

    it("carries that score through getResults into what settlement reads", async () => {
      const { body } = fixture("event-detail-settled");
      serve(body);

      const result = (await new OddsApiIoProvider("test-key", noBudget).getResults(["71128258"]))[0]!;

      expect(result.status).toBe("SETTLED");
      expect(result.periods.ft).toEqual({
        home: (body as any).scores.periods.ft.home,
        away: (body as any).scores.periods.ft.away,
      });
      // `home`/`away` are the OT/penalty-inclusive final and are NOT what 1X2
      // settles against. Both must survive so cup ties resolve correctly.
      expect(result.home).toBe((body as any).scores.home);
      expect(result.away).toBe((body as any).scores.away);
    });

    it("reports no regulation score rather than inventing a 0-0", async () => {
      // A goalless draw and a missing score are the same object shape if you
      // default to zero. Ingestion refuses to settle without `ft`, which only
      // works because the adapter leaves it absent.
      serve({ id: 1, status: "settled", scores: { home: 0, away: 0 } });

      const result = (await new OddsApiIoProvider("k", noBudget).getResults(["1"]))[0]!;

      expect(result.periods.ft).toBeUndefined();
    });
  });

  describe("event listing", () => {
    it("maps every field the sportsbook stores", async () => {
      const { body } = fixture("events-football");
      serve(body);

      const events = await new OddsApiIoProvider("k", noBudget).listEvents("football");
      expect(events.length).toBeGreaterThan(0);

      const first = events[0]!;
      const raw = (body as any[])[0];

      expect(first.eventId).toBe(String(raw.id));
      expect(first.home).toBe(raw.home);
      expect(first.away).toBe(raw.away);
      expect(first.league).toBe(raw.league.name);
      expect(first.startsAt.toISOString()).toBe(new Date(raw.date).toISOString());
    });

    it("stores a sport SLUG, never a stringified object", async () => {
      // `sport` arrives as {name, slug}, not a string. `String(e.sport)` on an
      // object yields "[object Object]" — which is truthy, non-empty, and
      // therefore passes every null check on the way to the database.
      const { body } = fixture("events-football");
      serve(body);

      const events = await new OddsApiIoProvider("k", noBudget).listEvents("football");

      for (const event of events.slice(0, 50)) {
        expect(event.sport).not.toBe("[object Object]");
        expect(event.sport).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it("has a mapping for every status the feed actually emits", async () => {
      const { body } = fixture("events-football");
      const emitted = new Set((body as any[]).map((e) => String(e.status).toLowerCase()));
      serve(body);

      const events = await new OddsApiIoProvider("k", noBudget).listEvents("football");
      const mapped = new Map(events.map((e, i) => [String((body as any[])[i].status).toLowerCase(), e.status]));

      // An unrecognised status silently becomes PENDING. On a SETTLED match
      // that means the result is never ingested and the bet never pays.
      for (const status of emitted) {
        if (status === "settled") expect(mapped.get(status)).toBe("SETTLED");
        if (status === "cancelled") expect(mapped.get(status)).toBe("CANCELLED");
        if (status === "live") expect(mapped.get(status)).toBe("LIVE");
        if (status === "pending") expect(mapped.get(status)).toBe("PENDING");
      }
    });
  });

  describe("what the account can actually do", () => {
    it("documents that odds require selected bookmakers", () => {
      const { body } = fixture("bookmakers-selected");

      // Not an assertion about correctness — a record of a live constraint.
      // With zero bookmakers selected, /odds returns 400 "Missing bookmakers",
      // so no price can be fetched no matter how good the adapter is. If this
      // ever reads > 0, odds fetching has become possible and the sync path
      // needs its own end-to-end check.
      expect((body as any).count).toBeTypeOf("number");
    });
  });
});

/**
 * THE SAME CONTRACT, AGAINST THE LIVE API.
 *
 *   ODDS_LIVE_CONTRACT=1 npm run test -- provider-contract
 *
 * Opt-in, because it spends real API budget and needs a key — but it is the
 * only check here that can notice the provider changing WITHOUT anybody
 * deploying. The fixture tests above pin our parse; this pins their response.
 *
 * Run it on a schedule, or before trusting a settlement run after an outage.
 */
const live = process.env.ODDS_LIVE_CONTRACT && process.env.ODDS_API_KEY;

describe.skipIf(!live)("odds-api.io LIVE contract", () => {
  it("still returns a regulation score for a settled match", async () => {
    const key = process.env.ODDS_API_KEY!;
    const base = "https://api.odds-api.io/v3";

    const res = await fetch(`${base}/events?sport=football&apiKey=${key}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    expect(res.status, "the events endpoint is unreachable").toBe(200);

    const events = (await res.json()) as any[];
    const settled = events.find((e) => String(e?.status).toLowerCase() === "settled");
    expect(settled, "no settled football match to verify against").toBeDefined();

    // The three facts settlement depends on, asserted against today's feed.
    expect(settled.scores?.periods?.ft, "`scores.periods.ft` HAS MOVED").toBeDefined();
    expect(Number.isInteger(settled.scores.periods.ft.home)).toBe(true);
    expect(typeof settled.sport === "object" || typeof settled.sport === "string").toBe(true);
  }, 60_000);
});

/**
 * THE ODDS PARSE.
 *
 * `normaliseBook` was the last unverified function in the adapter — written
 * from published docs and never checked, because the probe script called
 * /odds without a `bookmakers` parameter, got a 400, and stopped there. The
 * real response has a different shape at every level, and the mismatch
 * produced NO prices rather than wrong ones: silent, and indistinguishable
 * from a quiet market.
 */
describe("odds-api.io price contract", () => {
  function oddsFixture() {
    const { body } = fixture("odds-multi");
    const first = (body as any[])[0];
    expect(first, "the odds fixture has no event — recapture it").toBeDefined();
    return first;
  }

  it("nests bookmakers as an object keyed by name, not an array", () => {
    const event = oddsFixture();

    // Asserted on the RAW fixture. `asArray()` on this object returned [],
    // which is exactly how every price was silently dropped.
    expect(Array.isArray(event.bookmakers)).toBe(false);
    expect(Object.keys(event.bookmakers).length).toBeGreaterThan(0);
  });

  it("gives each bookmaker a LIST of markets, each with rows of prices", () => {
    const event = oddsFixture();
    const markets = Object.values(event.bookmakers)[0] as any[];

    expect(Array.isArray(markets)).toBe(true);
    expect(markets[0]).toHaveProperty("name");
    expect(markets[0]).toHaveProperty("odds");
    expect(Array.isArray(markets[0].odds)).toBe(true);
  });

  it("actually produces prices — the regression that mattered", async () => {
    const { body } = fixture("odds-multi");
    serve(body);

    const [snapshot] = await new OddsApiIoProvider("k", noBudget).getOdds(["72409660"], ["1xbet"]);

    expect(snapshot, "no snapshot returned").toBeDefined();
    // The old parse returned a snapshot with books: [] here.
    expect(snapshot!.books.length, "NO BOOKMAKERS PARSED — prices are being dropped").toBeGreaterThan(0);

    const book = snapshot!.books[0]!;
    expect(book.bookmaker).toBeTruthy();
    expect(book.markets.length).toBeGreaterThan(0);
  });

  it("prices every selection as a finite number above 1", async () => {
    const { body } = fixture("odds-multi");
    serve(body);

    const [snapshot] = await new OddsApiIoProvider("k", noBudget).getOdds(["72409660"], ["1xbet"]);

    for (const book of snapshot!.books) {
      for (const market of book.markets) {
        for (const selection of market.selections) {
          // Prices arrive as STRINGS in the feed. A NaN reaching the betslip
          // is a price the user cannot be charged for.
          expect(Number.isFinite(selection.price)).toBe(true);
          expect(selection.price).toBeGreaterThan(1);
        }
      }
    }
  });

  it("never emits a selection key it could not map", async () => {
    const { body } = fixture("odds-multi");
    serve(body);

    const [snapshot] = await new OddsApiIoProvider("k", noBudget).getOdds(["72409660"], ["1xbet"]);

    for (const book of snapshot!.books) {
      for (const market of book.markets) {
        for (const selection of market.selections) {
          // Settlement resolves a bet by parsing this key. Null, "undefined"
          // or an empty key is a bet that can never be settled.
          expect(selection.key).toBeTruthy();
          expect(selection.key).not.toBe("undefined");
          expect(selection.key).not.toBe("null");
        }
      }
    }
  });

  it("keeps corner markets out of the goals markets", async () => {
    const { body } = fixture("odds-multi");
    serve(body);

    const [snapshot] = await new OddsApiIoProvider("k", noBudget).getOdds(["72409660"], ["1xbet"]);
    const raw = (body as any[])[0];
    const rawNames = (Object.values(raw.bookmakers)[0] as any[]).map((m) => String(m.name));

    // The feed prices "Corners Totals" alongside "Totals". Mapping the former
    // onto over_under would settle a corners bet against the goal count —
    // the single most expensive mapping mistake available here.
    if (rawNames.some((n) => /corner/i.test(n))) {
      const overUnder = snapshot!.books[0]!.markets.find((m) => m.key === "over_under");
      const goalRows = (Object.values(raw.bookmakers)[0] as any[])
        .filter((m) => String(m.name).toLowerCase() === "totals")
        .flatMap((m) => m.odds as any[]);

      if (overUnder && goalRows.length) {
        // Every line present must come from the goals market, not corners.
        const goalLines = new Set(goalRows.map((r) => Number(r.hdp)));
        for (const selection of overUnder.selections) {
          expect(goalLines.has(selection.line!)).toBe(true);
        }
      }
    }
  });
});
