import type Redis from "ioredis";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { BookmakerOdds, OddsProvider, OddsSnapshot } from "./provider";
import { OutOfBudgetError } from "./budget";

/**
 * THE ONE RULE
 * ------------
 * This worker is the ONLY thing in the system that talks to the odds provider.
 * API routes read from Redis/Postgres. Never from the provider.
 *
 * That's what makes 500 req/day survive real traffic: 10 users and 10,000
 * users cost you exactly the same number of upstream calls.
 *
 * BUDGET PLAN (free tier: 100/hr, 500/day)
 *   fixtures  every 30 min  ->  48/day   (1 call, next 14 days of football)
 *   odds delta every  5 min -> 288/day   (1 call, /odds/updated)
 *   live tick  every  1 min ->  ~60/day  (only while matches are in play —
 *                                          zero calls when the live board is empty)
 *   ----------------------------------------------------------------
 *   ~396/day, leaving ~100 in reserve for user-triggered refreshes.
 */

const CACHE_TTL_SEC = 900;

export interface SyncConfig {
  sport: string;
  /** Free tier allows exactly 2. Pick the ones your users actually use. */
  bookmakers: string[];
}

export class OddsSyncWorker {
  private lastDelta = new Date(Date.now() - 10 * 60_000);

  constructor(
    private provider: OddsProvider,
    private prisma: PrismaService,
    private redis: Redis,
    private cfg: SyncConfig,
  ) {}

  /** Every 30 min. Cheap — one call covers the next 14 days. */
  async syncFixtures(): Promise<void> {
    await this.guard("fixtures", async () => {
      const events = await this.provider.listEvents(this.cfg.sport);

      for (const e of events) {
        await this.prisma.event.upsert({
          where: {
            provider_providerEventId: { provider: this.provider.name, providerEventId: e.eventId },
          },
          create: {
            provider: this.provider.name,
            providerEventId: e.eventId,
            sport: e.sport,
            league: e.league,
            home: e.home,
            away: e.away,
            startsAt: e.startsAt,
            status: e.status,
          },
          update: {
            startsAt: e.startsAt,
            status: e.status,
            league: e.league,
          },
        });
      }
    });
  }

  /**
   * Every 5 min. One call, returns only what moved.
   * This is the endpoint that makes the free tier viable — without it you'd
   * be re-fetching your whole watchlist every cycle.
   */
  async syncOddsDelta(): Promise<void> {
    await this.guard("odds-delta", async () => {
      const since = this.lastDelta;
      const cursor = new Date(); // capture BEFORE the call, not after

      const snapshots = await this.provider.getUpdatedSince(since, {
        sport: this.cfg.sport,
      });

      if (snapshots) {
        await this.persist(snapshots);
        this.lastDelta = cursor;
      } else {
        await this.fullRefreshWatchlist();
      }
    });
  }

  /**
   * Every 1 min — but only while something is actually live. An empty live
   * board costs zero upstream calls, so this never burns budget outside
   * match hours; the ~60/day estimate assumes a handful of hours of live
   * football a day, not 24/7 polling.
   */
  async syncLiveOdds(): Promise<void> {
    await this.guard("live-tick", async () => {
      const liveEvents = await this.prisma.event.findMany({
        where: { status: "live" },
        select: { providerEventId: true },
      });
      if (liveEvents.length === 0) return;

      const snapshots = await this.provider.getOdds(
        liveEvents.map((e) => e.providerEventId),
        this.cfg.bookmakers,
      );
      await this.persist(snapshots);
    });
  }

  /** Fallback when the provider has no delta endpoint. Batches by 10. */
  private async fullRefreshWatchlist(): Promise<void> {
    const events = await this.prisma.event.findMany({
      where: {
        status: { in: ["pending", "live"] },
        startsAt: { gte: new Date(), lte: new Date(Date.now() + 48 * 60 * 60_000) },
      },
      orderBy: { startsAt: "asc" },
      take: 40,
      select: { providerEventId: true },
    });

    const snapshots = await this.provider.getOdds(
      events.map((e) => e.providerEventId),
      this.cfg.bookmakers,
    );
    await this.persist(snapshots);
  }

  private async persist(snapshots: OddsSnapshot[]): Promise<void> {
    const pipe = this.redis.pipeline();

    for (const snap of snapshots) {
      // Append-only history — you need this for odds-movement charts AND for
      // proving what price a user was shown when they placed a bet.
      await this.prisma.oddsSnapshot.create({
        data: {
          provider: this.provider.name,
          providerEventId: snap.eventId,
          payload: snap.books as unknown as Prisma.InputJsonValue,
          fetchedAt: snap.fetchedAt,
        },
      });

      // Normalized rows Phase 3 can actually reference by stable id.
      await this.upsertMarketsAndSelections(snap);

      // Hot path: what the bet slip reads.
      pipe.set(`odds:${snap.eventId}`, JSON.stringify(snap), "EX", CACHE_TTL_SEC);
    }

    await pipe.exec();
  }

  /**
   * We're mirroring one reference bookmaker's prices, not running a pricing
   * engine — the first configured bookmaker with data for this event wins.
   * (Rejected: averaging books, or picking the best price for the user —
   * that's real pricing logic, out of scope here.)
   */
  private canonicalBook(snap: OddsSnapshot): BookmakerOdds | undefined {
    for (const name of this.cfg.bookmakers) {
      const book = snap.books.find((b) => b.bookmaker === name);
      if (book) return book;
    }
    return snap.books[0];
  }

  private async upsertMarketsAndSelections(snap: OddsSnapshot): Promise<void> {
    const book = this.canonicalBook(snap);
    if (!book) return;

    const event = await this.prisma.event.findUnique({
      where: {
        provider_providerEventId: { provider: this.provider.name, providerEventId: snap.eventId },
      },
      select: { id: true },
    });
    // Odds arrived before the fixtures job ever saw this event — skip. The
    // next fixtures pass creates it; the next delta pass picks odds back up.
    if (!event) return;

    const syncStartedAt = new Date();

    for (const market of book.markets) {
      const marketRow = await this.prisma.market.upsert({
        where: { eventId_key: { eventId: event.id, key: market.key } },
        create: { eventId: event.id, key: market.key, status: "open", updatedAt: syncStartedAt },
        update: { status: "open", updatedAt: syncStartedAt },
      });

      for (const sel of market.selections) {
        await this.prisma.selection.upsert({
          where: { marketId_key: { marketId: marketRow.id, key: sel.key } },
          create: {
            marketId: marketRow.id,
            key: sel.key,
            label: sel.label,
            line: sel.line ?? null,
            currentPriceDecimal: sel.price,
            status: "open",
            updatedAt: syncStartedAt,
          },
          update: {
            label: sel.label,
            line: sel.line ?? null,
            currentPriceDecimal: sel.price,
            status: "open",
            updatedAt: syncStartedAt,
          },
        });
      }
    }

    // Anything for this event not touched in this pass has fallen out of the
    // provider's response (market pulled, event suspended pre-kickoff, ...).
    // Suspend it rather than silently leaving it bettable on stale data —
    // this is what makes Phase 3's "reject bets on suspended markets" mean
    // anything.
    await this.prisma.selection.updateMany({
      where: { market: { eventId: event.id }, status: "open", updatedAt: { lt: syncStartedAt } },
      data: { status: "suspended", updatedAt: new Date() },
    });
    await this.prisma.market.updateMany({
      where: { eventId: event.id, status: "open", updatedAt: { lt: syncStartedAt } },
      data: { status: "suspended", updatedAt: new Date() },
    });
  }

  private async guard(job: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof OutOfBudgetError) {
        // Expected under load. Log and skip — do NOT retry, that's how you
        // spend tomorrow's quota too.
        console.warn(`[odds] ${job} skipped: ${err.message}`);
        return;
      }
      console.error(`[odds] ${job} failed`, err);
      throw err;
    }
  }
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
