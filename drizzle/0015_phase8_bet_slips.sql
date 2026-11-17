-- Phase 8: bet slips, system bets, bankers, and the fuller status set.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- HOW A SYSTEM BET IS REPRESENTED
-- Each combination becomes an ORDINARY accumulator in `bets`. A 2/3 system is
-- three bet rows grouped by one slip.
--
-- This is the whole reason the phase is small. Settlement, exposure, cash-out,
-- the statement and every money invariant already handle an accumulator and are
-- heavily tested; expanding a system into accumulators means none of them has
-- to learn what a system is. The alternative -- one row carrying a system, with
-- settlement computing partial outcomes across combinations -- would have put
-- new arithmetic inside the most dangerous code in the product.
--
-- Same trade as modelling wallet buckets as wallet rows in phase 4: reuse the
-- machinery that is already proven.

CREATE TYPE "bet_slip_kind" AS ENUM ('SINGLE', 'MULTIPLE', 'SYSTEM');
--> statement-breakpoint

CREATE TABLE "bet_slips" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "kind" "bet_slip_kind" NOT NULL,

  -- Combination size, counting bankers. NULL for a single or a straight
  -- accumulator, where there is only one combination by definition.
  "system_size" integer,
  "selection_count" integer NOT NULL,
  "banker_count" integer DEFAULT 0 NOT NULL,

  -- What the customer typed. The TOTAL is unit x combinations, which is the
  -- number people misread: a 100 naira 2/3 costs 300 naira.
  "unit_stake_minor" bigint NOT NULL,
  "combination_count" integer NOT NULL,
  "total_stake_minor" bigint NOT NULL,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "bet_slips_selection_count_positive" CHECK ("selection_count" > 0),
  CONSTRAINT "bet_slips_combination_count_positive" CHECK ("combination_count" > 0),
  CONSTRAINT "bet_slips_unit_stake_positive" CHECK ("unit_stake_minor" > 0),
  CONSTRAINT "bet_slips_banker_count_valid" CHECK (
    "banker_count" >= 0 AND "banker_count" < "selection_count"
  ),
  CONSTRAINT "bet_slips_system_size_valid" CHECK (
    "system_size" IS NULL
    OR ("system_size" >= 1 AND "system_size" <= "selection_count"
        AND "system_size" >= "banker_count")
  ),
  -- The arithmetic that decides what the customer is charged, enforced by the
  -- database rather than trusted from the application. If these ever disagree,
  -- somebody has been billed an amount that does not follow from their slip.
  CONSTRAINT "bet_slips_total_is_unit_times_combinations" CHECK (
    "total_stake_minor" = "unit_stake_minor" * "combination_count"
  ),
  -- A single or a multiple is exactly one combination, by definition.
  CONSTRAINT "bet_slips_non_system_is_one_combination" CHECK (
    "kind" = 'SYSTEM' OR "combination_count" = 1
  ),
  CONSTRAINT "bet_slips_system_has_size" CHECK (
    "kind" <> 'SYSTEM' OR "system_size" IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX "bet_slips_user_idx" ON "bet_slips" ("user_id", "created_at" DESC);
--> statement-breakpoint

-- A placed slip is a record of what the customer chose. Nothing about its
-- shape may change afterwards.
CREATE OR REPLACE FUNCTION "bet_slips_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'bet slip % is immutable once placed', OLD."id"
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "bet_slips_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "bet_slips"
  FOR EACH ROW EXECUTE FUNCTION "bet_slips_immutable"();
--> statement-breakpoint

-- ============================================================================
-- BETS
-- ============================================================================

-- Nullable: every bet placed before this migration belongs to no slip, and
-- backfilling an invented one would claim a grouping that never existed.
ALTER TABLE "bets" ADD COLUMN "slip_id" uuid
  REFERENCES "bet_slips"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint

-- Which combination within the slip, 0-based. Lets support say "the third
-- combination" and mean something specific.
ALTER TABLE "bets" ADD COLUMN "combination_index" integer;
--> statement-breakpoint

ALTER TABLE "bets" ADD CONSTRAINT "bets_combination_index_valid" CHECK (
  "combination_index" IS NULL OR "combination_index" >= 0
);
--> statement-breakpoint

CREATE INDEX "bets_slip_idx" ON "bets" ("slip_id", "combination_index");
--> statement-breakpoint

-- One row per combination per slip; a repeat would mean the expansion ran
-- twice and the customer was charged twice.
CREATE UNIQUE INDEX "bets_slip_combination_unique"
  ON "bets" ("slip_id", "combination_index")
  WHERE "slip_id" IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- STATUS
-- ============================================================================

-- The master build prompt lists ten bet statuses. Three are added here; the
-- rest are deliberately NOT, and the reasons matter:
--
--   CANCELLED       -- what VOID already means in this ledger. A second word
--                      for the same refund would let two code paths disagree.
--   DRAFT/ACCEPTED  -- a bet row only exists once the stake has been debited
--                      inside the placement transaction. There is no moment
--                      where a bet exists and has not been accepted, so a
--                      status for it would always be a lie.
--
--   PARTIALLY_WON / PARTIALLY_LOST are real: a system slip can settle with
--   some combinations winning and others losing, and neither WON nor LOST
--   describes that. They apply to the SLIP view, not to an individual
--   combination, which is always a plain accumulator.
ALTER TYPE "bet_status" ADD VALUE IF NOT EXISTS 'PARTIALLY_WON';
--> statement-breakpoint
ALTER TYPE "bet_status" ADD VALUE IF NOT EXISTS 'PARTIALLY_LOST';
--> statement-breakpoint

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT USAGE ON TYPE "bet_slip_kind" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bet_slips" TO app_role;
