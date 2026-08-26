-- Phase 2: odds ingestion — events, markets, selections, raw snapshot history,
-- and the shared upstream-call budget.
--
-- Like the Phase 1 baseline, this contains CHECK constraints and role grants
-- that Drizzle's schema DSL cannot express. Run it only through the unpooled
-- owner/migration connection.

CREATE TYPE "event_status" AS ENUM ('PENDING', 'LIVE', 'SETTLED', 'CANCELLED');
--> statement-breakpoint
CREATE TYPE "market_status" AS ENUM ('OPEN', 'SUSPENDED', 'SETTLED', 'VOID');
--> statement-breakpoint

CREATE TABLE "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "sport" text NOT NULL,
  "league" text NOT NULL,
  "home" text NOT NULL,
  "away" text NOT NULL,
  "starts_at" timestamp(6) with time zone NOT NULL,
  "status" "event_status" DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "events_provider_event_unique" ON "events" ("provider", "provider_event_id");
--> statement-breakpoint
CREATE INDEX "events_status_starts_at_idx" ON "events" ("status", "starts_at");
--> statement-breakpoint

CREATE TABLE "markets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "key" text NOT NULL,
  "status" "market_status" DEFAULT 'OPEN' NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  -- Keep in sync with the MarketKey union in src/modules/odds/canonical.ts.
  -- A CHECK rather than an enum so adding a market type is a constraint
  -- widening, not an enum ALTER.
  CONSTRAINT "markets_key_supported" CHECK (
    "key" IN ('1x2', 'double_chance', 'over_under', 'btts', 'handicap', 'correct_score', 'ht_ft')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "markets_event_key_unique" ON "markets" ("event_id", "key");
--> statement-breakpoint

CREATE TABLE "selections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "market_id" uuid NOT NULL REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "line" numeric(6, 2),
  -- NUMERIC, never float. Phase 3 locks this price onto the bet row and
  -- settles against the stored value.
  "current_price_decimal" numeric(7, 3) NOT NULL,
  "status" "market_status" DEFAULT 'OPEN' NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  -- Decimal odds below 1.0 would pay out less than the stake. A price at or
  -- under 1 means suspended or malformed, never bettable.
  CONSTRAINT "selections_price_gt_one" CHECK ("current_price_decimal" > 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "selections_market_key_unique" ON "selections" ("market_id", "key");
--> statement-breakpoint

-- Append-only raw history across ALL bookmakers, independent of whichever one
-- ingestion later treats as canonical. Evidence of what a user was shown.
CREATE TABLE "odds_snapshots" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "odds_snapshots_event_fetched_idx"
  ON "odds_snapshots" ("provider", "provider_event_id", "fetched_at" DESC);
--> statement-breakpoint

-- NOTE: the upstream call budget lives in Redis, not Postgres — it needs an
-- atomic check-and-claim across serverless instances (Lua script). See
-- src/modules/odds/budget.ts.

-- Role grants, matching the Phase 1 owner/runtime split.
GRANT USAGE ON TYPE "event_status", "market_status" TO app_role;
--> statement-breakpoint

-- Ingestion upserts fixtures/markets/selections and flips status to SUSPENDED,
-- so it needs UPDATE. None of these are money tables.
GRANT SELECT, INSERT, UPDATE ON TABLE "events", "markets", "selections" TO app_role;
--> statement-breakpoint

-- Snapshots are evidence, so they get the ledger treatment: insert and read
-- only, never rewritten.
GRANT SELECT, INSERT ON TABLE "odds_snapshots" TO app_role;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "odds_snapshots_id_seq" TO app_role;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "odds_snapshots" FROM app_role;
