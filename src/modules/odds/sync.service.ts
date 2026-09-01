import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { batchClassifier, type BatchClassifier } from "@/modules/sports/classify-batch";
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

export interface FixtureSyncResult {
  upserted: number;
  classified: number;
  failed: number;
  /** Transactions and statements spent classifying — what the benchmark reads. */
  transactions: number;
  statements: number;
}

export interface SyncConfig {
  sport: string;
  /** Free tier allows exactly 2. Order matters — see canonicalBook(). */
  bookmakers: string[];
}

/**
 * How far ahead a fixture sync reaches.
 *
 * Matches the documented intent of the job. Beyond this the provider is
 * listing fixtures whose prices will have moved many times before anybody
 * can bet on them, and each one still costs an upsert plus taxonomy work.
 */
const FIXTURE_HORIZON_DAYS = 14;

/**
 * Rows per upsert statement.
 *
 * Large enough to collapse hundreds of round trips into a handful, small
 * enough that one statement stays a short lock and a manageable parse — and
 * that a failing chunk is cheap to retry row by row.
 */
const UPSERT_CHUNK = 50;

export class OddsSyncService {
  private lastDelta = new Date(Date.now() - 10 * 60_000);

  constructor(
    private readonly provider: OddsProvider,
    private readonly config: SyncConfig,
    private readonly classifier: BatchClassifier = batchClassifier,
  ) {}

  /** Every 30 min. Cheap — one call covers the next 14 days. */
  async syncFixtures(): Promise<FixtureSyncResult> {
    return this.guard("fixtures", async () => {
      /*
       * Ask for a BOUNDED window, and ingest only what can still be bet on.
       *
       * The docstring above always claimed "one call covers the next 14 days",
       * but no `to` was ever passed, so the provider returned its full catalogue
       * — around 5000 football events, of which only ~775 had not already
       * finished. Each row then costs an upsert plus taxonomy resolution and
       * classification, so a job scheduled every 30 minutes was taking hours
       * and never completing. It looked like a slow job; it was an unbounded one.
       *
       * Already-settled fixtures are skipped rather than upserted. A match that
       * has finished is not something anybody can place a bet on, and any
       * settled event we actually care about is already in the table from when
       * it was pending — that is what the settlement poller reads.
       */
      const horizon = new Date(Date.now() + FIXTURE_HORIZON_DAYS * 24 * 60 * 60_000);
      const returned = await this.provider.listEvents(this.config.sport, { to: horizon });
      const found = returned.filter(
        (event) => event.status === "PENDING" || event.status === "LIVE",
      );

      let classified = 0;
      let failed = 0;

      /*
       * Upsert in BATCHES, not one row at a time.
       *
       * The pooled client is `max: 1` by design — it avoids multiplying
       * connection pressure during serverless scale-out — so adding
       * application-level concurrency would simply queue on one connection and
       * buy nothing. The only lever that helps is fewer round trips, so rows
       * go up in chunks and the loop below reads the returned ids.
       *
       * The chunk is bounded rather than "all of them": a single statement
       * carrying 775 rows is a large parse and a long lock, and one failure
       * would take the whole catalogue with it.
       */
      const upserted = new Map<string, string>();
      for (let start = 0; start < found.length; start += UPSERT_CHUNK) {
        const chunk = found.slice(start, start + UPSERT_CHUNK);
        const values = chunk.map((e) => ({
          provider: this.provider.name,
          providerEventId: e.eventId,
          sport: e.sport,
          league: e.league,
          home: e.home,
          away: e.away,
          startsAt: e.startsAt,
          status: e.status,
        }));

        try {
          const rows = await db
            .insert(events)
            .values(values)
            .onConflictDoUpdate({
              target: [events.provider, events.providerEventId],
              set: {
                startsAt: sql`excluded.starts_at`,
                status: sql`excluded.status`,
                league: sql`excluded.league`,
                updatedAt: new Date(),
              },
            })
            .returning({ id: events.id, providerEventId: events.providerEventId });

          for (const row of rows) upserted.set(row.providerEventId, row.id);
        } catch (error) {
          /*
           * One bad row must not lose the batch.
           *
           * Falling back to row-at-a-time for the failing chunk isolates the
           * offender: the other events in it still land, and the failure is
           * counted rather than swallowed. Silently dropping 50 fixtures
           * because one had a malformed date is exactly the kind of loss
           * nobody notices until a customer cannot find a match.
           */
          console.error(
            `[odds-sync] batch upsert failed for ${chunk.length} events; retrying individually`,
            error,
          );
          for (const [index, value] of values.entries()) {
            try {
              const [row] = await db
                .insert(events)
                .values(value)
                .onConflictDoUpdate({
                  target: [events.provider, events.providerEventId],
                  set: {
                    startsAt: value.startsAt,
                    status: value.status,
                    league: value.league,
                    updatedAt: new Date(),
                  },
                })
                .returning({ id: events.id });
              if (row) upserted.set(value.providerEventId, row.id);
            } catch (rowError) {
              failed += 1;
              console.error(
                `[odds-sync] could not upsert event ${chunk[index]?.eventId}`,
                rowError,
              );
            }
          }
        }
      }

      /*
       * Classify the whole batch, not one fixture at a time.
       *
       * This loop used to call `resolveFixture` and `classifyEvent` per event.
       * Both are correct, and both open their own transaction, so a 775-event
       * sync spent roughly fifteen thousand round trips re-resolving the same
       * leagues and the same clubs. See `classify-batch.ts` for the shape;
       * the summary is that the cost is now proportional to DISTINCT entities
       * rather than to events.
       *
       * Still best-effort and still never fatal: an unclassified fixture is a
       * real match somebody should be able to bet on, and taking the board
       * down because a competition label changed shape is the worse outcome.
       * Individual failures are reported per event rather than swallowed.
       */
      const toClassify = found
        .filter((e) => upserted.has(e.eventId))
        .map((e) => ({
          eventId: upserted.get(e.eventId)!,
          sport: e.sport,
          league: e.league,
          home: e.home,
          away: e.away,
        }));

      let classificationStatements = 0;
      let classificationTransactions = 0;
      try {
        const outcome = await this.classifier.classify(toClassify);
        classified = outcome.classified;
        classificationStatements = outcome.statements;
        classificationTransactions = outcome.transactions;
        for (const failure of outcome.failures) {
          console.error("[odds-sync] could not classify fixture", failure.eventId, failure.reason);
        }
        if (outcome.unresolvedSport > 0) {
          console.warn(
            `[odds-sync] ${outcome.unresolvedSport} event(s) reference a sport that is not seeded`,
          );
        }
      } catch (error) {
        // The events themselves are already committed and bettable. A
        // classification outage degrades browsing, not betting.
        console.error("[odds-sync] batch classification failed", error);
      }

      return {
        upserted: upserted.size,
        classified,
        failed,
        transactions: classificationTransactions,
        statements: classificationStatements,
      };
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

      /*
       * The bookmaker is REQUIRED, and omitting it failed silently for the
       * life of this project.
       *
       * `/odds/updated` answers `400 Missing bookmaker parameter` without one.
       * This call passed only `sport`, so the adapter sent `bookmaker:
       * undefined`, the URL builder dropped it, and every run since the job
       * was written threw before reaching `persist()`. The result was a
       * sportsbook with real fixtures and ZERO stored prices — and because the
       * throw happens before the `if (snapshots)` check, the
       * `fullRefreshWatchlist()` fallback never ran either.
       *
       * Note the singular/plural mismatch that hid it: the provider takes one
       * `bookmaker`, while SyncConfig holds a `bookmakers` array. The first
       * entry is the canonical price by the existing convention — the same
       * order `canonicalBook()` resolves.
       */
      const bookmaker = this.config.bookmakers[0];
      if (!bookmaker) {
        throw new Error("odds sync requires at least one configured bookmaker");
      }

      const snapshots = await this.provider.getUpdatedSince(since, {
        sport: this.config.sport,
        bookmaker,
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

  /**
   * Prices the upcoming watchlist in one batched call.
   *
   * Public because it is also the only way to FILL an empty board. The delta
   * endpoint returns only what moved since the last cursor, so a database with
   * no prices yet stays empty until something happens to change — which is
   * precisely the state this platform sat in. An operator bringing the board
   * up, or a QA run proving the pipeline end to end, has to be able to ask for
   * everything rather than for the difference.
   */
  async refreshWatchlist(): Promise<{ events: number }> {
    return this.guard("watchlist-refresh", () => this.fullRefreshWatchlist());
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
