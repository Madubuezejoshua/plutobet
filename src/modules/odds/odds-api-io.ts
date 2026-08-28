import { ApiBudget, apiBudget as defaultBudget, type CallPriority } from "./budget";
import { mapMarketKey, mapSelectionKey } from "./canonical";
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
    if (!res.ok) {
      throw new Error(`odds-api.io ${path} -> ${res.status} ${await res.text()}`);
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

  async getOdds(eventIds: string[], bookmakers: string[]): Promise<OddsSnapshot[]> {
    const out: OddsSnapshot[] = [];
    for (let i = 0; i < eventIds.length; i += MULTI_CHUNK) {
      const chunk = eventIds.slice(i, i + MULTI_CHUNK);
      const raw = await this.get<unknown>("/odds/multi", {
        eventIds: chunk.join(","),
        bookmakers: bookmakers.join(","),
      });
      out.push(...this.normaliseSnapshots(raw));
    }
    return out;
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

  async getResults(eventIds: string[]): Promise<EventResult[]> {
    const out: EventResult[] = [];
    for (const id of eventIds) {
      const raw = this.asRecord(
        await this.get<unknown>(`/events/${id}`, {}, "CRITICAL"),
      );
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

  private normaliseSnapshots(raw: unknown): OddsSnapshot[] {
    return this.asArray(raw).map((entry) => ({
      eventId: String(entry.eventId ?? entry.id),
      fetchedAt: new Date(),
      books: this.asArray(entry.bookmakers ?? entry.books)
        .map((b) => this.normaliseBook(b))
        .filter((b): b is BookmakerOdds => b !== null),
    }));
  }

  private normaliseBook(b: ProviderRecord): BookmakerOdds | null {
    const markets: ProviderMarket[] = [];

    for (const [rawKey, payload] of Object.entries(this.asRecord(b.markets))) {
      const key = mapMarketKey(rawKey);
      if (!key) continue; // unsupported market — skip, don't guess

      const payloadRecord = this.asRecord(payload);
      const selections = this.asArray(payloadRecord.selections ?? payload)
        .map((s) => {
          const label = String(s.name ?? s.label ?? "");
          const line = s.line !== undefined ? Number(s.line) : undefined;
          return {
            key: mapSelectionKey(key, label, line),
            label,
            price: Number(s.odds ?? s.price),
            line,
          };
        })
        // A zero/NaN price means suspended. Never surface it as bettable.
        .filter((s) => Number.isFinite(s.price) && s.price > 1)
        // An unmappable label is dropped rather than guessed. Previously each
        // market had a fallthrough default ("home", "no", ...), so a label we
        // did not anticipate produced a selection whose key contradicted the
        // price shown to the user.
        .flatMap<ProviderSelection>((s) =>
          s.key === null ? [] : [{ key: s.key, label: s.label, price: s.price, line: s.line }],
        );

      if (selections.length) markets.push({ key, selections });
    }

    if (!markets.length) return null;

    return {
      bookmaker: String(b.name ?? b.bookmaker),
      markets,
      updatedAt: new Date(String(b.updatedAt ?? b.lastUpdate ?? Date.now())),
    };
  }

}
