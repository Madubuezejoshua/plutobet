-- Phase 7: booking codes and per-customer odds-change handling.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- A booking code is a shareable slip: someone builds selections, gets a short
-- code, and a friend loads it.
--
-- THE RULE THAT SHAPES THIS TABLE
-- A booking code stores SELECTIONS, never a price and never a stake.
--
-- Storing the price would invite showing it back later, and a price from
-- Tuesday is not a price today -- the loader would see odds nobody will honour.
-- Storing the stake would make a shared code look like a bet somebody had
-- already agreed to. The master build prompt is explicit that loading a code
-- must never place a bet; keeping stake and price out of the row is what makes
-- that structural rather than a promise in the UI.
--
-- Everything about a loaded code is therefore re-priced live, and the loader
-- confirms their own wager with their own money.

CREATE TABLE "booking_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- Short, human-shareable, read aloud over the phone. Uppercase and drawn
  -- from an unambiguous alphabet (see booking-code.ts) so a mistyped character
  -- is a miss rather than someone else's slip.
  "code" text NOT NULL,

  -- Who built it. Nullable: a code outlives the account that made it, and
  -- deleting the author must not break every friend's copy.
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT,

  -- How many times it has been loaded. Interesting to marketing, and a cheap
  -- signal for the risk team when one code is loaded ten thousand times.
  "load_count" integer DEFAULT 0 NOT NULL,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  -- Codes expire. A slip of fixtures that kicked off last month is noise, and
  -- an unbounded table of them is a slow leak.
  "expires_at" timestamp(6) with time zone NOT NULL,

  CONSTRAINT "booking_codes_format" CHECK ("code" ~ '^[A-Z0-9]{6,10}$'),
  CONSTRAINT "booking_codes_load_count_nonnegative" CHECK ("load_count" >= 0),
  CONSTRAINT "booking_codes_expiry_after_creation" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "booking_codes_code_unique" ON "booking_codes" ("code");
--> statement-breakpoint
CREATE INDEX "booking_codes_creator_idx" ON "booking_codes" ("created_by", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE "booking_code_selections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "booking_code_id" uuid NOT NULL
    REFERENCES "booking_codes"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  "selection_id" uuid NOT NULL
    REFERENCES "selections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "position" integer NOT NULL,

  CONSTRAINT "booking_code_selections_position_nonnegative" CHECK ("position" >= 0)
);
--> statement-breakpoint

-- The same selection twice in one slip is not an accumulator, it is a bug.
CREATE UNIQUE INDEX "booking_code_selections_unique"
  ON "booking_code_selections" ("booking_code_id", "selection_id");
--> statement-breakpoint
CREATE INDEX "booking_code_selections_code_idx"
  ON "booking_code_selections" ("booking_code_id", "position");
--> statement-breakpoint

-- A booking code is a record of what someone shared. Editing one after the
-- fact would change what a friend loads without their knowing, so the rows are
-- immutable apart from the load counter.
CREATE OR REPLACE FUNCTION "booking_codes_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'booking code % is immutable once shared', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "booking_codes_guard_trigger"
  BEFORE UPDATE ON "booking_codes"
  FOR EACH ROW EXECUTE FUNCTION "booking_codes_guard"();
--> statement-breakpoint

-- ============================================================================
-- ODDS CHANGE PREFERENCE
-- ============================================================================

-- What to do when the price moves between building a slip and confirming it.
--
--   ASK          stop and show the customer both prices (default)
--   HIGHER_ONLY  accept silently when the change is in their favour
--   ANY          accept any change
--
-- ASK is the default deliberately. The alternatives are conveniences the
-- customer opts into; defaulting to ANY would mean a drifted price is accepted
-- on their behalf without their ever having agreed to it.
CREATE TYPE "odds_change_policy" AS ENUM ('ASK', 'HIGHER_ONLY', 'ANY');
--> statement-breakpoint

ALTER TABLE "user_preferences"
  ADD COLUMN "odds_change_policy" "odds_change_policy" DEFAULT 'ASK' NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT USAGE ON TYPE "odds_change_policy" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "booking_codes" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "booking_code_selections" TO app_role;
