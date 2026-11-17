-- Phase 6: the sports hierarchy.
--
-- Sport -> Country -> Competition -> Event -> Market -> Selection
--
-- NOTE: SQL comments here stay within WIN1252. A migration is sent to the
-- server as a literal string and re-encoded to the CLIENT encoding, which on
-- a default Windows Postgres is WIN1252 -- and a character with no equivalent
-- there (an arrow, a naira sign) fails the whole migration with a message that
-- points at the statement rather than the comment. An em-dash maps; an arrow
-- does not.
--
-- WHAT WAS WRONG
-- `events` carried `sport` and `league` as free TEXT and the two team names as
-- free TEXT. Every spelling the provider emitted was its own de-facto entity,
-- so there was no way to ask "how have these two done against each other",
-- "what has this club's form been", or even "list the competitions" without
-- a DISTINCT over strings that drift.
--
-- That is a browsing problem today and a much worse problem later: the AI
-- analysis in phase 18 reasons over exactly these entities, and building it on
-- fragmented strings would mean building it twice.
--
-- WHY THE TEXT COLUMNS SURVIVE
-- `events.sport` / `events.league` / `events.home` / `events.away` are kept and
-- are NOT redundant. They record what the PROVIDER called things at ingest
-- time; the new foreign keys record what we RESOLVED them to. Keeping both
-- means a resolution that later turns out wrong can be traced and redone from
-- the original, which is impossible once the source string is discarded.
--
-- WHY THE FOREIGN KEYS ARE NULLABLE
-- Resolution can fail — a new provider format, an unparseable label. An event
-- that cannot be resolved must still be bettable, because refusing to take a
-- bet on a real fixture is worse than not knowing which competition it belongs
-- to. Unresolved rows are visible and can be backfilled.

CREATE TABLE "sports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  -- Off by default: a sport appears to customers only once its markets are
  -- modelled and settleable. Ingesting fixtures is not the same as being able
  -- to price and settle them.
  "active" boolean DEFAULT false NOT NULL,
  "display_order" integer DEFAULT 100 NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "sports_key_format" CHECK ("key" ~ '^[a-z0-9-]{2,40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sports_key_unique" ON "sports" ("key");
--> statement-breakpoint

CREATE TABLE "competitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sport_id" uuid NOT NULL REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "key" text NOT NULL,
  "name" text NOT NULL,
  -- Free text, not an ISO code: the provider says "England", and competitions
  -- like the Champions League have no country at all.
  "country" text,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "competitions_key_format" CHECK ("key" ~ '^[a-z0-9-]{1,120}$')
);
--> statement-breakpoint
-- Scoped to the sport: "premier-league" exists in more than one.
CREATE UNIQUE INDEX "competitions_sport_key_unique" ON "competitions" ("sport_id", "key");
--> statement-breakpoint
CREATE INDEX "competitions_country_idx" ON "competitions" ("sport_id", "country");
--> statement-breakpoint

CREATE TABLE "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sport_id" uuid NOT NULL REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The conservative match key from canonical-name.ts. Two clubs share one
  -- only when no spelling difference could distinguish them.
  "key" text NOT NULL,
  -- What a person should see: accents intact, designators intact.
  "name" text NOT NULL,
  "country" text,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "teams_key_format" CHECK ("key" ~ '^[a-z0-9-]{1,120}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_sport_key_unique" ON "teams" ("sport_id", "key");
--> statement-breakpoint

-- Spellings that conservative normalisation cannot reconcile — "Spurs" for
-- Tottenham, "Man Utd" for Manchester United.
--
-- Deliberately a SEPARATE table rather than cleverer normalisation: every row
-- here is a decision somebody made, auditable and reversible. A normaliser
-- aggressive enough to merge these automatically would also merge clubs that
-- merely look alike, and that mistake cannot be undone.
CREATE TABLE "team_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sport_id" uuid NOT NULL REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "alias_key" text NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "team_aliases_key_format" CHECK ("alias_key" ~ '^[a-z0-9-]{1,120}$')
);
--> statement-breakpoint
-- One alias resolves to exactly one team within a sport. Without this, an
-- ambiguous alias would resolve differently depending on row order — the same
-- class of bug that made wallet lookups non-deterministic in phase 4.
CREATE UNIQUE INDEX "team_aliases_sport_alias_unique" ON "team_aliases" ("sport_id", "alias_key");
--> statement-breakpoint
CREATE INDEX "team_aliases_team_idx" ON "team_aliases" ("team_id");
--> statement-breakpoint

-- ============================================================================
-- EVENTS
-- ============================================================================

ALTER TABLE "events" ADD COLUMN "sport_id" uuid REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "competition_id" uuid REFERENCES "competitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "home_team_id" uuid REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "away_team_id" uuid REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint

-- A fixture cannot be a team against itself. Cheap to check, and it catches a
-- resolution bug that would otherwise produce a market nobody can settle.
ALTER TABLE "events" ADD CONSTRAINT "events_teams_distinct" CHECK (
  "home_team_id" IS NULL OR "away_team_id" IS NULL OR "home_team_id" <> "away_team_id"
);
--> statement-breakpoint

CREATE INDEX "events_competition_idx" ON "events" ("competition_id", "starts_at");
--> statement-breakpoint
-- The odds board's query: upcoming fixtures for one sport, soonest first.
CREATE INDEX "events_sport_status_idx" ON "events" ("sport_id", "status", "starts_at");
--> statement-breakpoint
CREATE INDEX "events_home_team_idx" ON "events" ("home_team_id", "starts_at" DESC);
--> statement-breakpoint
CREATE INDEX "events_away_team_idx" ON "events" ("away_team_id", "starts_at" DESC);
--> statement-breakpoint

-- ============================================================================
-- SEED
-- ============================================================================

-- Football is the only sport with modelled, settleable markets, so it is the
-- only one active. The rest are listed so the taxonomy is ready and the
-- ordering is deliberate rather than alphabetical, but a fixture in an
-- inactive sport is ingested and not offered.
INSERT INTO "sports" ("key", "name", "active", "display_order") VALUES
  ('football',      'Football',      true,  10),
  ('basketball',    'Basketball',    false, 20),
  ('tennis',        'Tennis',        false, 30),
  ('cricket',       'Cricket',       false, 40),
  ('boxing',        'Boxing',        false, 50),
  ('mma',           'MMA',           false, 60),
  ('baseball',      'Baseball',      false, 70),
  ('ice-hockey',    'Ice Hockey',    false, 80),
  ('volleyball',    'Volleyball',    false, 90),
  ('table-tennis',  'Table Tennis',  false, 100),
  ('motorsport',    'Motorsport',    false, 110),
  ('esports',       'Esports',       false, 120)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Attach existing fixtures to their sport where the name already matches.
-- Competitions and teams are resolved by the application on the next sync,
-- because doing it here would mean reimplementing the normaliser in SQL and
-- letting the two drift.
UPDATE "events" e
SET "sport_id" = s."id"
FROM "sports" s
WHERE e."sport_id" IS NULL AND lower(e."sport") = s."key";
--> statement-breakpoint

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON TABLE "sports", "competitions", "teams", "team_aliases" TO app_role;
