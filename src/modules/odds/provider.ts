/**
 * Provider-agnostic contract.
 *
 * Nothing outside this module should ever import an odds-api.io type. When we
 * outgrow the free tier and move to Sportradar / BetsAPI, that means a new
 * adapter and one changed line in the factory.
 */

// The key vocabulary is a domain concern shared with settlement, not a
// provider one — it lives in ./canonical.ts. Re-exported here so adapters
// have a single import.
export type { MarketKey } from "./canonical";

/** Canonical odds are DECIMAL. Convert at the adapter boundary, never later. */
export type DecimalOdds = number;

export interface ProviderSelection {
  /** Stable key we can settle against, e.g. "home" | "draw" | "over_2.5" */
  key: string;
  label: string;
  price: DecimalOdds;
  /** Handicap / total line, when the market has one. */
  line?: number;
}

export interface ProviderMarket {
  key: import("./canonical").MarketKey;
  selections: ProviderSelection[];
}

export interface BookmakerOdds {
  bookmaker: string;
  markets: ProviderMarket[];
  /** The provider's own update timestamp — used for staleness checks. */
  updatedAt: Date;
}

export interface OddsSnapshot {
  eventId: string;
  books: BookmakerOdds[];
  /** When WE fetched it. Distinct from the provider's updatedAt. */
  fetchedAt: Date;
}

export type ProviderEventStatus = "PENDING" | "LIVE" | "SETTLED" | "CANCELLED";

export interface SportEvent {
  eventId: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  startsAt: Date;
  status: ProviderEventStatus;
}

export interface PeriodScore {
  home: number;
  away: number;
}

export interface EventResult {
  eventId: string;
  status: ProviderEventStatus;
  /** OT/penalty-inclusive final. */
  home: number;
  away: number;
  /**
   * p1, p2, ... = periods/halves/quarters
   * ft = regulation result, ot = extra time, ap = penalty shootout
   *
   * Phase 4 settles 1X2 against `ft`, NOT against home/away — a match won on
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
   * Delta poll. Returns only odds that moved since `since`, or null when the
   * provider has no delta endpoint — the caller then falls back to a full
   * refresh of its watchlist.
   */
  getUpdatedSince(
    since: Date,
    opts: { sport?: string; bookmaker?: string },
  ): Promise<OddsSnapshot[] | null>;

  getResults(eventIds: string[]): Promise<EventResult[]>;
}
