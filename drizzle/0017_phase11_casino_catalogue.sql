-- Phase 11: casino game catalogue and provider registry.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- The callback handling in casino.service.ts already existed and is sound:
-- sessions, bet/win/refund/rollback, idempotent on round-plus-operation. What
-- was missing was everything a player can see -- there was no list of games,
-- so there was nothing to launch.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD
-- No RNG, no game logic, no outcome generation. Outcomes come from a certified
-- aggregator, because self-built RNG does not pass GLI-33 and a betting
-- platform that generates its own casino results has no way to prove it did so
-- fairly. This is a catalogue and a launcher, not a game engine.

CREATE TYPE "casino_category" AS ENUM (
  'SLOTS',
  'TABLE',
  'LIVE_CASINO',
  'CRASH',
  'INSTANT',
  'JACKPOT'
);
--> statement-breakpoint

CREATE TABLE "casino_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  -- Off until an integration is actually verified. A provider row is not the
  -- same as a working rail, and listing games nobody can launch is the kind of
  -- fake surface the build rules forbid.
  "active" boolean DEFAULT false NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "casino_providers_key_format" CHECK ("key" ~ '^[a-z0-9-]{2,40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "casino_providers_key_unique" ON "casino_providers" ("key");
--> statement-breakpoint

CREATE TABLE "casino_games" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL
    REFERENCES "casino_providers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The provider's own identifier. What gets sent when launching a session.
  "provider_game_id" text NOT NULL,
  "name" text NOT NULL,
  "category" "casino_category" NOT NULL,
  "thumbnail_url" text,

  -- Return to player, in basis points: 9600 = 96.00%. Nullable because not
  -- every provider publishes it, and an invented figure on a gambling product
  -- is a misrepresentation rather than a missing field.
  "rtp_basis_points" integer,

  "active" boolean DEFAULT true NOT NULL,
  "display_order" integer DEFAULT 100 NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "casino_games_rtp_plausible" CHECK (
    "rtp_basis_points" IS NULL
    OR ("rtp_basis_points" > 5000 AND "rtp_basis_points" <= 10000)
  )
);
--> statement-breakpoint

-- One row per game per provider. The same title from two aggregators is two
-- rows, because they are two different integrations with different round
-- references.
CREATE UNIQUE INDEX "casino_games_provider_game_unique"
  ON "casino_games" ("provider_id", "provider_game_id");
--> statement-breakpoint
CREATE INDEX "casino_games_category_idx"
  ON "casino_games" ("category", "display_order") WHERE "active" = true;
--> statement-breakpoint

-- Which games a player has opened, for the "recently played" rail. Not a
-- money record -- game_rounds is that -- so it is safe to overwrite.
CREATE TABLE "casino_recent_plays" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "game_id" uuid NOT NULL REFERENCES "casino_games"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "last_played_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "game_id")
);
--> statement-breakpoint
CREATE INDEX "casino_recent_plays_user_idx"
  ON "casino_recent_plays" ("user_id", "last_played_at" DESC);
--> statement-breakpoint

-- game_rounds gained a game reference so history can name what was played
-- rather than showing a provider's opaque game string.
ALTER TABLE "game_rounds" ADD COLUMN "game_id" uuid
  REFERENCES "casino_games"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
CREATE INDEX "game_rounds_user_created_idx" ON "game_rounds" ("user_id", "created_at" DESC);
--> statement-breakpoint

GRANT USAGE ON TYPE "casino_category" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "casino_providers", "casino_games", "casino_recent_plays" TO app_role;
