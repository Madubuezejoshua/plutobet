import { and, asc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { db } from "@/db/pooled";
import { taxonomyService } from "@/modules/sports/taxonomy.service";
import { OutOfBudgetError } from "./budget";
import { events, markets, oddsSnapshots, selections } from "./schema";
import type { BookmakerOdds, OddsProvider, OddsSnapshot } from "./provider";

/**
 * THE ONE RULE
 * ------------
 * This service is the ONLY thing in the system that talks to the odds
 * provider. Read paths go to Postgres. That is what makes 500 req/day survive
 * real traffic: 10 users and 10,000 users cost exactly the same upstream.
 *
 * BUDGET PLAN (free tier: 100/hr, 500/day)
 *   fixtures   every 30 min ->  48/day  (1 call, next 14 days of football)
 *   odds delta every  5 min -> 288/day  (1 call, /odds/updated)
 *   live tick  every  1 min -> ~60/day  (only while matches are in play —
 *                                        an empty live board costs nothing)
 *   ------------------------------------------------------------------
 *   ~396/day, leaving ~100 in reserve for user-triggered refreshes.
 */

export interface SyncConfig {
  sport: string;
  /** Free tier allows exactly 2. Order matters — see canonicalBook(). */
  bookmakers: string[];
}

export class OddsSyncService {
  private lastDelta = new Date(Date.now() - 10 * 60_000);

  constructor(
    private readonly provider: OddsProvider,
    private readonly config: SyncConfig,
  ) {}

  /** Every 30 min. Cheap — one call covers the next 14 days. */
  async syncFixtures(): Promise<{ upserted: number }> {
    return this.guard("fixtures", async () => {
      const found = await this.provider.listEvents(this.config.sport);

      let classified = 0;

      for (const e of found) {
        const [row] = await db
          .insert(events)
          .values({
            provider: this.provider.name,
            providerEventId: e.eventId,
            sport: e.sport,
            league: e.league,
            home: e.home,
            away: e.away,
            startsAt: e.startsAt,
            status: e.status,
          })
          .onConflictDoUpdate({
            target: [events.provider, events.providerEventId],
            set: {
              startsAt: e.startsAt,
              status: e.status,
              league: e.league,
              updatedAt: new Date(),
            },
          })
          .returning({ id: events.id });

        /*
         * Resolve the fixture onto the sports hierarchy.
         *
         * Deliberately best-effort and never fatal: an unclassified fixture is
         * still a real match that people should be able to bet on, and
         * refusing to ingest it because a competition label changed shape
         * would take the whole board down over a formatting change. Failures
         * are logged and the row can be backfilled.
         */
        if (row) {
          try {
            const resolved = await taxonomyService.resolveFixture({
              sport: e.sport,
              league: e.league,
              home: e.home,
              away: e.away,
            });
            if (resolved) {
              await taxonomyService.classifyEvent(row.id, resolved);
              classified += 1;
            }
          } catch (error) {
            console.error("[odds-sync] could not classify fixture", e.eventId, error);
          }
        }
      }

      return { upserted: found.length, classified };
    });
  }

  /**
   * Every 5 min. One call, returns only what moved. This endpoint is what
   * makes the free tier viable — without it we'd re-fetch the whole watchlist
   * every cycle.
   */
  async syncOddsDelta(): Promise<{ events: number }> {
    return this.guard("odds-delta", async () => {
      const since = this.lastDelta;
      const cursor = new Date(); // capture BEFORE the call, not after

      const snapshots = await this.provider.getUpdatedSince(since, {
        sport: this.config.sport,
      });

      if (snapshots) {
        await this.persist(snapshots);
        this.lastDelta = cursor;
        return { events: snapshots.length };
      }
      return this.fullRefreshWatchlist();
    });
  }

  /**
   * Every 1 min, but only while something is actually live — an empty live
   * board costs zero upstream calls, so this never burns budget outside match
   * hours.
   */
  async syncLiveOdds(): Promise<{ events: number }> {
    return this.guard("live-tick", async () => {
      const live = await db
        .select({ providerEventId: events.providerEventId })
        .from(events)
        .where(and(eq(events.status, "LIVE"), eq(events.provider, this.provider.name)));

      if (live.length === 0) return { events: 0 };

      const snapshots = await this.provider.getOdds(
        live.map((e) => e.providerEventId),
        this.config.bookmakers,
      );
      await this.persist(snapshots);
      return { events: snapshots.length };
    });
  }

  /** Fallback when the provider has no delta endpoint. */
  private async fullRefreshWatchlist(): Promise<{ events: number }> {
    const watchlist = await db
      .select({ providerEventId: events.providerEventId })
      .from(events)
      .where(
        and(
          eq(events.provider, this.provider.name),
          inArray(events.status, ["PENDING", "LIVE"]),
          gte(events.startsAt, new Date()),
          lte(events.startsAt, new Date(Date.now() + 48 * 60 * 60_000)),
        ),
      )
      .orderBy(asc(events.startsAt))
      .limit(40);

    const snapshots = await this.provider.getOdds(
      watchlist.map((e) => e.providerEventId),
      this.config.bookmakers,
    );
    await this.persist(snapshots);
    return { events: snapshots.length };
  }

  private async persist(snapshots: OddsSnapshot[]): Promise<void> {
    for (const snap of snapshots) {
      // Append-only history: odds-movement charts, and evidence of what price
      // a user was shown when they placed a bet.
      await db.insert(oddsSnapshots).values({
        provider: this.provider.name,
        providerEventId: snap.eventId,
        payload: snap.books,
        fetchedAt: snap.fetchedAt,
      });

      await this.upsertMarketsAndSelections(snap);
    }
  }

  /**
   * We mirror one reference bookmaker's prices rather than running a pricing
   * engine — the first configured bookmaker with data for this event wins.
   * (Rejected: averaging books, or always taking the best price for the user.
   * Both are real pricing decisions and belong to risk, not ingestion.)
   */
  private canonicalBook(snap: OddsSnapshot): BookmakerOdds | undefined {
    for (const name of this.config.bookmakers) {
      const book = snap.books.find((b) => b.bookmaker === name);
      if (book) return book;
    }
    return snap.books[0];
  }

  private async upsertMarketsAndSelections(snap: OddsSnapshot): Promise<void> {
    const book = this.canonicalBook(snap);
    if (!book) return;

    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.provider, this.provider.name),
          eq(events.providerEventId, snap.eventId),
        ),
      )
      .limit(1);

    // Odds arrived before the fixtures job ever saw this event. Skip: the next
    // fixtures pass creates it and the next delta pass picks the odds back up.
    if (!event) return;

    const syncStartedAt = new Date();

    for (const market of book.markets) {
      const [marketRow] = await db
        .insert(markets)
        .values({
          eventId: event.id,
          key: market.key,
          status: "OPEN",
          updatedAt: syncStartedAt,
        })
        .onConflictDoUpdate({
          target: [markets.eventId, markets.key],
          set: { status: "OPEN", updatedAt: syncStartedAt },
        })
        .returning({ id: markets.id });

      // onConflictDoUpdate always returns the row, so this is unreachable in
      // practice — but silently skipping a market would leave stale prices
      // bettable, so fail loudly rather than continue.
      if (!marketRow) {
        throw new Error(`market upsert returned no row for ${snap.eventId}/${market.key}`);
      }

      for (const sel of market.selections) {
        await db
          .insert(selections)
          .values({
            marketId: marketRow.id,
            key: sel.key,
            label: sel.label,
            line: sel.line === undefined ? null : String(sel.line),
            currentPriceDecimal: String(sel.price),
            status: "OPEN",
            updatedAt: syncStartedAt,
          })
          .onConflictDoUpdate({
            target: [selections.marketId, selections.key],
            set: {
              label: sel.label,
              line: sel.line === undefined ? null : String(sel.line),
              currentPriceDecimal: String(sel.price),
              status: "OPEN",
              updatedAt: syncStartedAt,
            },
          });
      }
    }

    // Anything for this event NOT touched in this pass has fallen out of the
    // provider's response — market pulled, suspended pre-kickoff, and so on.
    // Suspend it rather than leaving stale prices bettable. This is what makes
    // Phase 3's "reject bets on suspended markets" mean anything.
    // Query builder rather than raw SQL: postgres.js cannot bind a Date
    // parameter through sql.execute, and the subquery keeps this to one
    // statement instead of round-tripping the market ids.
    const eventMarketIds = db
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.eventId, event.id));

    await db
      .update(selections)
      .set({ status: "SUSPENDED", updatedAt: new Date() })
      .where(
        and(
          eq(selections.status, "OPEN"),
          lt(selections.updatedAt, syncStartedAt),
          inArray(selections.marketId, eventMarketIds),
        ),
      );
    await db
      .update(markets)
      .set({ status: "SUSPENDED", updatedAt: new Date() })
      .where(
        and(
          eq(markets.eventId, event.id),
          eq(markets.status, "OPEN"),
          lt(markets.updatedAt, syncStartedAt),
        ),
      );
  }

  private async guard<T>(job: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof OutOfBudgetError) {
        // Expected under load. Skip this tick — do NOT retry, that is how you
        // spend tomorrow's quota too.
        console.warn(`[odds] ${job} skipped: ${error.message}`);
        return { events: 0, upserted: 0 } as T;
      }
      throw error;
    }
  }
}
