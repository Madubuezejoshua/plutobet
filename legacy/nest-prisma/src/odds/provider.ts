/**
 * Provider-agnostic contract.
 *
 * Nothing outside this folder should ever import an odds-api.io type.
 * When you outgrow the free tier and move to Sportradar / BetsAPI,
 * you write a new adapter and change one line in the factory.
 */

export type MarketKey = "1x2" | "over_under" | "handicap" | "btts";

/** Canonical odds are DECIMAL. Convert at the adapter boundary, never later. */
export type DecimalOdds = number;

export interface Selection {
  /** Stable key you can settle against, e.g. "home" | "away" | "draw" | "over_2.5" */
  key: string;
  label: string;
  price: DecimalOdds;
  /** Handicap / total line, when the market has one. */
  line?: number;
}

export interface Market {
  key: MarketKey;
  selections: Selection[];
}

export interface BookmakerOdds {
  bookmaker: string;
  markets: Market[];
  /** Provider's own update timestamp — used for staleness checks. */
  updatedAt: Date;
}

export interface OddsSnapshot {
  eventId: string;
  books: BookmakerOdds[];
  /** When WE fetched it. Distinct from the provider's updatedAt. */
  fetchedAt: Date;
}

export interface SportEvent {
  eventId: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  startsAt: Date;
  status: "pending" | "live" | "settled" | "cancelled";
}

export interface PeriodScore {
  home: number;
  away: number;
}

export interface EventResult {
  eventId: string;
  status: SportEvent["status"];
  /** OT/penalty-inclusive final. */
  home: number;
  away: number;
  /**
   * p1, p2, ... = periods/halves/quarters
   * ft = regulation result
   * ot = extra time,  ap = penalty shootout
   *
   * Settle 1X2 against `ft`, NOT against home/away — a match won on
   * penalties is a DRAW for match-result markets.
   */
  periods: Record<string, PeriodScore>;
}

export interface OddsProvider {
  readonly name: string;

  listEvents(sport: string, opts?: { to?: Date }): Promise<SportEvent[]>;
  listLiveEvents(): Promise<SportEvent[]>;

  /** Batch. Implementations MUST chunk internally to the provider's cap. */
  getOdds(eventIds: string[], bookmakers: string[]): Promise<OddsSnapshot[]>;

  /**
   * Delta poll. Returns only odds that moved since `since`.
   * Returns null if the provider has no delta endpoint — caller then
   * falls back to full refresh of its watchlist.
   */
  getUpdatedSince(
    since: Date,
    opts: { sport?: string; bookmaker?: string },
  ): Promise<OddsSnapshot[] | null>;

  getResults(eventIds: string[]): Promise<EventResult[]>;
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
