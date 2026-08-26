import type {
  OddsProvider,
  OddsSnapshot,
  SportEvent,
  EventResult,
  Market,
  MarketKey,
  BookmakerOdds,
} from "./provider";
import { ApiBudget } from "./budget";

const BASE = "https://api.odds-api.io/v3";

/** Their hard cap on /odds/multi. Do not raise without checking docs. */
const MULTI_CHUNK = 10;

/**
 * NOTE ON RESPONSE SHAPES
 * -----------------------
 * The exact JSON field names below are best-effort from the public docs.
 * Before you build on top of this, run `scripts/probe.ts` (included) against
 * a real key, dump one /odds response, and correct `normaliseBook()`.
 * Everything else in the codebase is insulated from that by OddsProvider,
 * so it's a one-function fix.
 */

export class OddsApiIoProvider implements OddsProvider {
  readonly name = "odds-api.io";

  constructor(
    private apiKey: string,
    private budget: ApiBudget,
  ) {}

  private async get<T>(
    path: string,
    params: Record<string, string | undefined>,
    priority: "background" | "critical" = "background",
  ): Promise<T> {
    await this.budget.spend(1, priority);

    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    // /sports and /bookmakers are public; sending the key anyway is harmless.
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
    // Defaults to next 14 days. Capped at 5000/response — paginate if you
    // ever widen `to` beyond a couple of weeks.
    const raw = await this.get<any>("/events", {
      sport,
      to: opts?.to?.toISOString(),
      limit: "500",
    });
    return this.asArray(raw).map((e) => this.normaliseEvent(e, sport));
  }

  async listLiveEvents(): Promise<SportEvent[]> {
    const raw = await this.get<any>("/events/live", {}, "critical");
    return this.asArray(raw).map((e) => this.normaliseEvent(e, e.sport));
  }

  async getOdds(
    eventIds: string[],
    bookmakers: string[],
  ): Promise<OddsSnapshot[]> {
    const out: OddsSnapshot[] = [];

    for (let i = 0; i < eventIds.length; i += MULTI_CHUNK) {
      const chunk = eventIds.slice(i, i + MULTI_CHUNK);
      const raw = await this.get<any>("/odds/multi", {
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
    const raw = await this.get<any>("/odds/updated", {
      since: since.toISOString(),
      sport: opts.sport,
      bookmaker: opts.bookmaker,
    });
    return this.normaliseSnapshots(raw);
  }

  async getResults(eventIds: string[]): Promise<EventResult[]> {
    const out: EventResult[] = [];
    for (const id of eventIds) {
      const raw = await this.get<any>(`/events/${id}`, {}, "critical");
      const e = raw?.data ?? raw;
      out.push({
        eventId: String(e.id ?? id),
        status: this.normaliseStatus(e.status),
        home: Number(e.scores?.home ?? 0),
        away: Number(e.scores?.away ?? 0),
        periods: e.scores?.periods ?? {},
      });
    }
    return out;
  }

  // ---------- normalisation ----------

  private asArray(raw: any): any[] {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.data)) return raw.data;
    if (Array.isArray(raw?.events)) return raw.events;
    return [];
  }

  private normaliseStatus(s: unknown): SportEvent["status"] {
    const v = String(s ?? "pending").toLowerCase();
    if (v === "live" || v === "inplay") return "live";
    if (v === "settled" || v === "finished" || v === "ended") return "settled";
    if (v === "cancelled" || v === "canceled") return "cancelled";
    return "pending";
  }

  private normaliseEvent(e: any, sport: string): SportEvent {
    return {
      eventId: String(e.id ?? e.eventId),
      sport: e.sport ?? sport,
      league: e.league?.name ?? e.league ?? "unknown",
      home: e.home?.name ?? e.home ?? e.participants?.[0]?.name ?? "",
      away: e.away?.name ?? e.away ?? e.participants?.[1]?.name ?? "",
      startsAt: new Date(e.startTime ?? e.commenceTime ?? e.date),
      status: this.normaliseStatus(e.status),
    };
  }

  private normaliseSnapshots(raw: any): OddsSnapshot[] {
    return this.asArray(raw).map((entry) => ({
      eventId: String(entry.eventId ?? entry.id),
      fetchedAt: new Date(),
      books: this.asArray(entry.bookmakers ?? entry.books)
        .map((b) => this.normaliseBook(b))
        .filter((b): b is BookmakerOdds => b !== null),
    }));
  }

  private normaliseBook(b: any): BookmakerOdds | null {
    const markets: Market[] = [];

    for (const [rawKey, payload] of Object.entries<any>(b.markets ?? {})) {
      const key = this.mapMarket(rawKey);
      if (!key) continue; // unsupported market — skip, don't guess

      const selections = this.asArray(payload?.selections ?? payload)
        .map((s: any) => ({
          key: this.mapSelection(key, s),
          label: String(s.name ?? s.label ?? ""),
          price: Number(s.odds ?? s.price),
          line: s.line !== undefined ? Number(s.line) : undefined,
        }))
        // A zero/NaN price means suspended. Never surface it as bettable.
        .filter((s) => Number.isFinite(s.price) && s.price > 1);

      if (selections.length) markets.push({ key, selections });
    }

    if (!markets.length) return null;

    return {
      bookmaker: String(b.name ?? b.bookmaker),
      markets,
      updatedAt: new Date(b.updatedAt ?? b.lastUpdate ?? Date.now()),
    };
  }

  private mapMarket(raw: string): MarketKey | null {
    const v = raw.toLowerCase().replace(/[\s_-]/g, "");
    if (["1x2", "moneyline", "ml", "matchwinner", "h2h"].includes(v)) return "1x2";
    if (["overunder", "totals", "total", "ou"].includes(v)) return "over_under";
    if (["handicap", "spread", "spreads", "asianhandicap"].includes(v))
      return "handicap";
    if (["btts", "bothteamstoscore"].includes(v)) return "btts";
    return null;
  }

  private mapSelection(market: MarketKey, s: any): string {
    const name = String(s.name ?? s.label ?? "").toLowerCase();

    if (market === "1x2") {
      if (name.includes("draw") || name === "x") return "draw";
      if (name.includes("away") || name === "2") return "away";
      return "home";
    }
    if (market === "over_under") {
      return `${name.startsWith("u") ? "under" : "over"}_${s.line}`;
    }
    if (market === "btts") return name.startsWith("y") ? "yes" : "no";
    return `${name.includes("away") ? "away" : "home"}_${s.line}`;
  }
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
