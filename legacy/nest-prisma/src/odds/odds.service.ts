import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import type { OddsSnapshot } from "./provider";

/**
 * The read path. Everything user-facing goes through here.
 *
 * This service has NO reference to OddsProvider and never will — that's the
 * Phase 2 acceptance criterion ("500 simulated concurrent users browsing odds
 * triggers zero upstream API calls"). Only OddsSyncWorker talks upstream.
 * A cache miss means stale-or-nothing, never a provider call.
 */

const LISTING_TTL_SEC = 30;

/**
 * Explicit DTO rather than leaking Prisma's row types. Two reasons that
 * matter: (1) Prisma returns Decimal objects for prices, which do NOT
 * survive a JSON round-trip as the same type — without normalising, a cache
 * hit and a cache miss would hand callers different shapes for the same
 * query, which is exactly the kind of bug that surfaces in production and
 * not in tests; (2) the socket layer in a later phase needs a small,
 * diffable payload, and that starts with controlling the shape here.
 */
export interface SelectionView {
  id: string;
  key: string;
  label: string;
  line: number | null;
  price: number;
}

export interface MarketView {
  id: string;
  key: string;
  selections: SelectionView[];
}

export interface EventView {
  id: string;
  providerEventId: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  startsAt: string;
  status: string;
  markets: MarketView[];
}

@Injectable()
export class OddsService {
  /**
   * Single-flight guard. Without it, a cold cache under real traffic sends
   * every concurrent browser to Postgres at once (a thundering herd) — 500
   * users became 250 simultaneous nested queries and took the DB connection
   * down. Concurrent misses for the same key now collapse into one query.
   * In-process only: with multiple app instances you get one query per
   * instance, not one globally, which is the right trade here (a Redis lock
   * would add a network round-trip and a failure mode to every cache miss).
   */
  private readonly inflight = new Map<string, Promise<EventView[]>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Raw snapshot for one event, as the sync worker last cached it. */
  async getEventOdds(providerEventId: string): Promise<OddsSnapshot | null> {
    const cached = await this.redis.get(`odds:${providerEventId}`);
    if (cached) return JSON.parse(cached) as OddsSnapshot;

    // Cache expired. Fall back to the newest persisted snapshot rather than
    // calling upstream — a user browsing must never cost budget.
    const row = await this.prisma.oddsSnapshot.findFirst({
      where: { providerEventId },
      orderBy: { fetchedAt: "desc" },
    });
    if (!row) return null;

    return {
      eventId: row.providerEventId,
      books: row.payload as unknown as OddsSnapshot["books"],
      fetchedAt: row.fetchedAt,
    };
  }

  /** Upcoming fixtures with their normalized, currently-open markets. */
  async listUpcoming(opts?: { sport?: string; limit?: number }): Promise<EventView[]> {
    const sport = opts?.sport ?? "all";
    const limit = opts?.limit ?? 50;
    const cacheKey = `odds:upcoming:${sport}:${limit}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as EventView[];

    // No await between here and the .set() below — concurrent callers that
    // resumed from their own cache miss will find this promise and await it
    // instead of issuing their own query.
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const query = this.loadUpcoming(cacheKey, opts?.sport, limit);
    this.inflight.set(cacheKey, query);
    return query;
  }

  private async loadUpcoming(cacheKey: string, sport: string | undefined, limit: number): Promise<EventView[]> {
    try {
      const rows = await this.prisma.event.findMany({
        where: {
          ...(sport ? { sport } : {}),
          status: { in: ["pending", "live"] },
          startsAt: { gte: new Date() },
        },
        orderBy: { startsAt: "asc" },
        take: limit,
        include: {
          markets: {
            where: { status: "open" },
            include: { selections: { where: { status: "open" } } },
          },
        },
      });

      const view: EventView[] = rows.map((e) => ({
        id: e.id,
        providerEventId: e.providerEventId,
        sport: e.sport,
        league: e.league,
        home: e.home,
        away: e.away,
        startsAt: e.startsAt.toISOString(),
        status: e.status,
        markets: e.markets.map((m) => ({
          id: m.id,
          key: m.key,
          selections: m.selections.map((s) => ({
            id: s.id,
            key: s.key,
            label: s.label,
            line: s.line === null ? null : Number(s.line),
            price: Number(s.currentPriceDecimal),
          })),
        })),
      }));

      await this.redis.set(cacheKey, JSON.stringify(view), "EX", LISTING_TTL_SEC);
      return view;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
