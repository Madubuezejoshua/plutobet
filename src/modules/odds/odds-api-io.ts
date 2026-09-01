import { ApiBudget, apiBudget as defaultBudget, type CallPriority } from "./budget";
import { mapMarketKey, mapSelectionKey } from "./canonical";
import {
  ProviderEventNotFoundError,
  ProviderUnknownEventsError,
  parseUnknownEventIds,
} from "./errors";
import type {
  BookmakerOdds,
  EventResult,
  OddsProvider,
  OddsSnapshot,
  ProviderEventStatus,
  ProviderMarket,
  ProviderSelection,
  SportEvent,
} from "./provider";

const BASE = "https://api.odds-api.io/v3";

/** Their hard cap on /odds/multi. Do not raise without checking the docs. */
const MULTI_CHUNK = 10;

type ProviderRecord = Record<string, unknown>;

function isProviderRecord(value: unknown): value is ProviderRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * NOTE ON RESPONSE SHAPES
 * -----------------------
 * The /events and /events/{id} shapes below are VERIFIED against real captured
 * responses and pinned by `__tests__/provider-contract.acceptance.spec.ts`.
 * Refresh the fixtures with `npm run odds:capture`; check the provider itself
 * with `npm run odds:contract`.
 *
 * `normaliseBook()` is the exception — it is still best-effort from the public
 * docs, because the account has no bookmakers selected and /odds therefore
 * answers `400 Missing bookmakers`. Select bookmakers in the odds-api.io
 * dashboard, capture a real /odds response, and correct it before trusting a
 * price. Everything else is insulated by the OddsProvider interface, so that
 * stays a one-function fix.
 */
export class OddsApiIoProvider implements OddsProvider {
  readonly name = "odds-api.io";

  constructor(
    private readonly apiKey: string,
    private readonly budget: ApiBudget = defaultBudget,
  ) {}

  private async get<T>(
    path: string,
    params: Record<string, string | undefined>,
    priority: CallPriority = "BACKGROUND",
  ): Promise<T> {
    await this.budget.spend(1, priority);

    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    url.searchParams.set("apiKey", this.apiKey);

    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 429) {
      throw new Error("odds-api.io rate limited (429) — budget guard drifted");
    }
    /*
     * A 404 is about ONE resource; every other failure is about the call.
     *
     * Raised as its own type so a caller iterating over event ids can skip the
     * one the provider has forgotten and keep the rest, while a 401, 429 or 5xx
     * still stops the run — those are batch-wide and retrying past them just
     * burns budget.
     */
    if (res.status === 404) {
      throw new ProviderEventNotFoundError(path.replace(/^\/events\//, ""));
    }
    if (!res.ok) {
      const body = await res.text();
      /*
       * A 400 that NAMES unknown event ids is about those ids, not the request.
       * Surfaced as its own type so a batch caller can drop them and retry with
       * the rest; any other 400 stays fatal, because guessing would turn every
       * malformed request into a silent partial success.
       */
      if (res.status === 400) {
        const unknown = parseUnknownEventIds(body);
        if (unknown.length > 0) throw new ProviderUnknownEventsError(unknown);
      }
      throw new Error(`odds-api.io ${path} -> ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  }

  async listEvents(sport: string, opts?: { to?: Date }): Promise<SportEvent[]> {
    const raw = await this.get<unknown>("/events", {
      sport,
      to: opts?.to?.toISOString(),
      limit: "500",
    });
    return this.asArray(raw).map((e) => this.normaliseEvent(e, sport));
  }

  async listLiveEvents(): Promise<SportEvent[]> {
    const raw = await this.get<unknown>("/events/live", {}, "CRITICAL");
    // No sport to fall back on here — the live feed spans all of them — so the
    // fallback is empty and `normaliseEvent` reads the slug off the event.
    return this.asArray(raw).map((e) => this.normaliseEvent(e, ""));
  }

  /**
   * Prices for a batch of events, tolerating ids the provider has dropped.
   *
   * We keep events after the provider forgets them, so a refresh chunk reliably
   * contains at least one stale id. That returned `400 One or more eventIds not
   * found`, which threw out of the chunk loop and lost the ENTIRE refresh — the
   * reason upcoming fixtures sat on the board with no prices and nobody could
   * place a bet on them.
   *
   * The provider names the offenders, so they are removed and the chunk is
   * retried once with the survivors. One retry, not a loop: if a second attempt
   * still names unknown ids, something else is wrong and quietly narrowing the
   * request until it succeeds would hide it.
   */
  async getOdds(eventIds: string[], bookmakers: string[]): Promise<OddsSnapshot[]> {
    const out: OddsSnapshot[] = [];
    for (let i = 0; i < eventIds.length; i += MULTI_CHUNK) {
      const chunk = eventIds.slice(i, i + MULTI_CHUNK);
      const snapshots = await this.oddsForChunk(chunk, bookmakers, true);
      out.push(...snapshots);
    }
    return out;
  }

  private async oddsForChunk(
    chunk: string[],
    bookmakers: string[],
    mayRetry: boolean,
  ): Promise<OddsSnapshot[]> {
    if (chunk.length === 0) return [];
    try {
      const raw = await this.get<unknown>("/odds/multi", {
        eventIds: chunk.join(","),
        bookmakers: bookmakers.join(","),
      });
      return this.normaliseSnapshots(raw);
    } catch (error) {
      if (!(error instanceof ProviderUnknownEventsError) || !mayRetry) throw error;

      const unknown = new Set(error.unknownEventIds);
      const survivors = chunk.filter((id) => !unknown.has(id));
      console.warn(
        `[odds] provider rejected ${unknown.size} stale event id(s); retrying with ${survivors.length}`,
      );
      return this.oddsForChunk(survivors, bookmakers, false);
    }
  }

  async getUpdatedSince(
    since: Date,
    opts: { sport?: string; bookmaker?: string },
  ): Promise<OddsSnapshot[]> {
    const raw = await this.get<unknown>("/odds/updated", {
      since: since.toISOString(),
      sport: opts.sport,
      bookmaker: opts.bookmaker,
    });
    return this.normaliseSnapshots(raw);
  }

  /**
   * Results for a batch of events.
   *
   * An event the provider no longer knows is SKIPPED, not fatal. It used to
   * throw, which meant one forgotten fixture returned nothing for the other
   * nineteen and stopped every bet in the batch from settling — every minute,
   * indefinitely, because that event sorts to the front of the queue each tick.
   *
   * The caller sees a shorter list and defers whatever is missing from it, so
   * the event backs off instead of blocking the queue. Any OTHER provider
   * failure still propagates: a rate limit or an auth failure is about the
   * whole run and must stop it.
   */
  async getResults(eventIds: string[]): Promise<EventResult[]> {
    const out: EventResult[] = [];
    for (const id of eventIds) {
      let raw: ProviderRecord;
      try {
        raw = this.asRecord(await this.get<unknown>(`/events/${id}`, {}, "CRITICAL"));
      } catch (error) {
        if (error instanceof ProviderEventNotFoundError) {
          console.warn(`[odds] provider no longer knows event ${id}; skipping it this tick`);
          continue;
        }
        throw error;
      }
      const e = this.asRecord(raw.data ?? raw);
      const scores = this.asRecord(e.scores);
      out.push({
        eventId: String(e.id ?? id),
        status: this.normaliseStatus(e.status),
        home: Number(scores.home ?? 0),
        away: Number(scores.away ?? 0),
        periods: (scores.periods ?? {}) as EventResult["periods"],
      });
    }
    return out;
  }

  // ---------- normalisation ----------

  private asRecord(raw: unknown): ProviderRecord {
    return isProviderRecord(raw) ? raw : {};
  }

  private asArray(raw: unknown): ProviderRecord[] {
    const record = this.asRecord(raw);
    const values = Array.isArray(raw)
      ? raw
      : Array.isArray(record.data)
        ? record.data
        : Array.isArray(record.events)
          ? record.events
          : [];
    return values.filter(isProviderRecord);
  }

  private normaliseStatus(s: unknown): ProviderEventStatus {
    const v = String(s ?? "pending").toLowerCase();
    if (v === "live" || v === "inplay") return "LIVE";
    if (v === "settled" || v === "finished" || v === "ended") return "SETTLED";
    if (v === "cancelled" || v === "canceled") return "CANCELLED";
    return "PENDING";
  }

  /**
   * Reads a field the feed sends as EITHER a bare string or a {name, slug}
   * object, and never as "[object Object]".
   *
   * `sport` and `league` arrive as objects; `home` and `away` arrive as
   * strings. `String()` on the object form yields "[object Object]" — which is
   * truthy, non-empty, and therefore survives every null check between here
   * and the database. Every event synced before this fix was stored with
   * sport = "[object Object]".
   *
   * `prefer` picks the key that suits the column: sport wants the slug
   * (an identifier we join on), league wants the name (shown to the customer).
   */
  private text(value: unknown, prefer: "slug" | "name"): string | undefined {
    if (typeof value === "string") return value || undefined;
    if (isProviderRecord(value)) {
      const first = value[prefer];
      const second = value[prefer === "slug" ? "name" : "slug"];
      if (typeof first === "string" && first) return first;
      if (typeof second === "string" && second) return second;
    }
    return undefined;
  }

  private normaliseEvent(e: ProviderRecord, sport: string): SportEvent {
    const participants = this.asArray(e.participants);
    return {
      eventId: String(e.id ?? e.eventId),
      sport: this.text(e.sport, "slug") ?? sport,
      league: this.text(e.league, "name") ?? "unknown",
      home: this.text(e.home, "name") ?? this.text(participants[0], "name") ?? "",
      away: this.text(e.away, "name") ?? this.text(participants[1], "name") ?? "",
      startsAt: new Date(String(e.startTime ?? e.commenceTime ?? e.date)),
      status: this.normaliseStatus(e.status),
    };
  }

  /**
   * Turns an /odds or /odds/multi response into snapshots.
   *
   * VERIFIED against real responses, and the previous version was wrong in a
   * way that produced no prices at all rather than wrong ones:
   *
   *   /odds/multi  ->  [ { id, bookmakers: { "1xbet": [ …markets ] } } ]
   *   /odds        ->    { id, bookmakers: { "1xbet": [ …markets ] } }
   *
   * `bookmakers` is an OBJECT KEYED BY BOOKMAKER NAME, not an array, so the
   * old `asArray(entry.bookmakers)` returned [] every time and every snapshot
   * came back with zero books. Silent, and indistinguishable from a quiet
   * market — which is why it survived until a real response was captured.
   */
  private normaliseSnapshots(raw: unknown): OddsSnapshot[] {
    // /odds returns a bare object; /odds/multi an array. Accept both.
    const entries = Array.isArray(raw) ? this.asArray(raw) : [this.asRecord(raw)];

    return entries
      .filter((entry) => entry.id !== undefined || entry.eventId !== undefined)
      .map((entry) => ({
        eventId: String(entry.eventId ?? entry.id),
        fetchedAt: new Date(),
        books: Object.entries(this.asRecord(entry.bookmakers))
          .map(([bookmaker, markets]) => this.normaliseBook(bookmaker, markets))
          .filter((b): b is BookmakerOdds => b !== null),
      }));
  }

  /**
   * One bookmaker's markets.
   *
   * Real shape — a LIST of markets, each holding rows of prices:
   *
   *   [ { name: "Double Chance", updatedAt, odds: [ { "1X": "1.74", … } ] },
   *     { name: "Totals",        updatedAt, odds: [ { hdp: 2.5, over: "3.33",
   *                                                   under: "1.3" }, … ] } ]
   *
   * Each row is one line of a market. `hdp` is the line itself; every OTHER
   * key on the row is a selection label whose value is the price as a STRING.
   * Rows repeat per line, which is why over_2.5 and over_3.5 arrive as
   * separate rows rather than as a line field on one selection.
   */
  private normaliseBook(bookmaker: string, rawMarkets: unknown): BookmakerOdds | null {
    const markets: ProviderMarket[] = [];
    let newestUpdate = 0;

    for (const entry of this.asArray(rawMarkets)) {
      const key = mapMarketKey(String(entry.name ?? ""));
      // Unsupported market — skip, never guess. "Corners Totals" must not
      // become a goals total, and the canonical mapper refuses it for us.
      if (!key) continue;

      const updated = Date.parse(String(entry.updatedAt ?? ""));
      if (Number.isFinite(updated)) newestUpdate = Math.max(newestUpdate, updated);

      const selections: ProviderSelection[] = [];

      for (const row of this.asArray(entry.odds)) {
        // `hdp` names the line and is not itself a selection.
        const line = row.hdp === undefined ? undefined : Number(row.hdp);
        if (line !== undefined && !Number.isFinite(line)) continue;

        for (const [label, rawPrice] of Object.entries(row)) {
          if (label === "hdp") continue;

          // Prices arrive as strings ("1.584"). Number() on a malformed one
          // gives NaN, which the guard below drops rather than surfacing.
          const price = Number(rawPrice);
          // A zero/NaN/1.0 price means suspended or unavailable. Never
          // surface it as bettable.
          if (!Number.isFinite(price) || price <= 1) continue;

          const selectionKey = mapSelectionKey(key, label, line);
          // An unmappable label is dropped rather than guessed. A selection
          // whose key contradicts the price shown to the user is a wrong
          // payout waiting to happen.
          if (!selectionKey) continue;

          selections.push({ key: selectionKey, label, price, line });
        }
      }

      if (selections.length) markets.push({ key, selections });
    }

    if (!markets.length) return null;

    return {
      bookmaker,
      markets,
      // The provider timestamps each market, not the book. The newest is the
      // honest answer to "how stale is this?" — an older one would make a
      // moving board look frozen and trip the staleness alarm.
      updatedAt: new Date(newestUpdate || Date.now()),
    };
  }
}
