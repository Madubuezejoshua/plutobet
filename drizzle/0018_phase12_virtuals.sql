-- Phase 12: virtual sports.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- Virtuals are simulated fixtures on a fixed schedule: a "match" every three
-- minutes, priced and settled from a provider's RNG.
--
-- WHY THIS REUSES THE SPORTSBOOK RATHER THAN DUPLICATING IT
-- A virtual fixture has an event, markets, selections, prices, bets and a
-- settlement -- structurally identical to a real one. The only real
-- differences are that the schedule is synthetic and the result arrives from
-- an RNG rather than a stadium.
--
-- So virtuals are modelled as EVENTS in the existing tables, distinguished by
-- their sport, with a small table holding the extra scheduling facts. That
-- means placement, exposure, cash-out, settlement and the ledger all work
-- unchanged. The alternative -- a parallel virtual_bets table with its own
-- settlement -- would mean a second, less-tested implementation of the most
-- dangerous code in the product.
--
-- Same reasoning as system bets expanding into ordinary accumulators, and
-- wallet buckets being wallet rows.

CREATE TABLE "virtual_rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The sportsbook event this round is priced and settled through.
  "event_id" uuid NOT NULL UNIQUE
    REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  "provider" text NOT NULL,
  "provider_round_id" text NOT NULL,
  -- e.g. virtual-football, virtual-horse-racing.
  "discipline" text NOT NULL,

  -- Virtuals run to a timetable rather than a fixture list. The number is what
  -- players refer to: "race 41".
  "round_number" integer NOT NULL,
  "scheduled_at" timestamp(6) with time zone NOT NULL,
  "settled_at" timestamp(6) with time zone,

  -- The provider's raw outcome, kept verbatim. A dispute about a virtual
  -- result can only be answered from exactly what they sent.
  "outcome" jsonb,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "virtual_rounds_round_number_positive" CHECK ("round_number" > 0),
  CONSTRAINT "virtual_rounds_discipline_format" CHECK ("discipline" ~ '^[a-z0-9-]{3,40}$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX "virtual_rounds_provider_round_unique"
  ON "virtual_rounds" ("provider", "provider_round_id");
--> statement-breakpoint
CREATE INDEX "virtual_rounds_schedule_idx"
  ON "virtual_rounds" ("discipline", "scheduled_at" DESC);
--> statement-breakpoint

-- A round's identity and schedule are fixed once published; only the outcome
-- is written later. Letting the schedule move after bets are placed would mean
-- changing what somebody bet on.
CREATE OR REPLACE FUNCTION "virtual_rounds_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."event_id" IS DISTINCT FROM OLD."event_id"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."provider_round_id" IS DISTINCT FROM OLD."provider_round_id"
     OR NEW."round_number" IS DISTINCT FROM OLD."round_number"
     OR NEW."scheduled_at" IS DISTINCT FROM OLD."scheduled_at" THEN
    RAISE EXCEPTION 'virtual round % identity and schedule are immutable', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- A published outcome is evidence; a corrected one goes through the same
  -- resettlement path as a real fixture rather than being overwritten here.
  IF OLD."outcome" IS NOT NULL AND NEW."outcome" IS DISTINCT FROM OLD."outcome" THEN
    RAISE EXCEPTION 'virtual round % outcome is already published', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "virtual_rounds_guard_trigger"
  BEFORE UPDATE ON "virtual_rounds"
  FOR EACH ROW EXECUTE FUNCTION "virtual_rounds_guard"();
--> statement-breakpoint

-- The disciplines, added to the sports taxonomy so they browse like any other
-- sport. Inactive until a provider is connected: a listed sport with no
-- fixtures is a dead end.
INSERT INTO "sports" ("key", "name", "active", "display_order") VALUES
  ('virtual-football',      'Virtual Football',      false, 200),
  ('virtual-horse-racing',  'Virtual Horse Racing',  false, 210),
  ('virtual-greyhounds',    'Virtual Greyhounds',    false, 220),
  ('virtual-basketball',    'Virtual Basketball',    false, 230)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "virtual_rounds" TO app_role;
