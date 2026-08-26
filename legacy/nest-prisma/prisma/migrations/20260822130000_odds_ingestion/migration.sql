-- Phase 2: odds ingestion — events, markets, selections, and the raw
-- snapshot history the sync worker already writes to.

CREATE TYPE event_status AS ENUM ('pending', 'live', 'settled', 'cancelled');

-- Shared by markets and selections — one lifecycle vocabulary for both, since
-- "settled"/"void" mean the same thing at either level and inventing two
-- near-identical enums would just be a trap for drift between them.
CREATE TYPE market_status AS ENUM ('open', 'suspended', 'settled', 'void');

-- ============================================================================
-- EVENTS
-- ============================================================================

CREATE TABLE events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  sport              TEXT NOT NULL,
  league             TEXT NOT NULL,
  home               TEXT NOT NULL,
  away               TEXT NOT NULL,
  starts_at          TIMESTAMPTZ NOT NULL,
  status             event_status NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_events_provider_event ON events (provider, provider_event_id);
CREATE INDEX idx_events_status_starts_at ON events (status, starts_at);

-- ============================================================================
-- MARKETS
-- ============================================================================

CREATE TABLE markets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id),
  -- Mirrors the MarketKey union in src/odds/provider.ts. Kept as TEXT + CHECK
  -- rather than a DB enum so adding a market type is a plain migration that
  -- widens the CHECK, not an enum-value ALTER — keep the two lists in sync.
  key        TEXT NOT NULL CHECK (key IN ('1x2', 'over_under', 'handicap', 'btts')),
  status     market_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_markets_event_key ON markets (event_id, key);

-- ============================================================================
-- SELECTIONS
-- ============================================================================

CREATE TABLE selections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id              UUID NOT NULL REFERENCES markets(id),
  key                    TEXT NOT NULL, -- e.g. 'home' | 'draw' | 'away' | 'over_2.5' | 'yes'
  label                  TEXT NOT NULL,
  -- Nullable: only over/under and handicap selections carry one. Lives here,
  -- not on markets, because a single "over_under" market bundles every line
  -- odds-api.io returns (over_1.5, under_1.5, over_2.5, ...) as separate
  -- selections — matches oddsApiIo.ts's mapSelection(), not the coarser
  -- one-line-per-market shape.
  line                   NUMERIC(6, 2),
  current_price_decimal  NUMERIC(7, 3) NOT NULL CHECK (current_price_decimal > 1),
  status                 market_status NOT NULL DEFAULT 'open',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_selections_market_key ON selections (market_id, key);

-- ============================================================================
-- ODDS SNAPSHOTS — append-only raw history (all bookmakers, not just the
-- canonical one). Needed for odds-movement charts and to prove what price a
-- user was actually shown, independent of what we later chose as canonical.
-- ============================================================================

CREATE TABLE odds_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  payload            JSONB NOT NULL,
  fetched_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_odds_snapshots_event ON odds_snapshots (provider, provider_event_id, fetched_at);
-- Archived pre-migration Prisma SQL; excluded from the active build.
