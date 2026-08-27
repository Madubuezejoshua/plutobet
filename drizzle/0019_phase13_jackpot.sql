-- Phase 13: jackpot competitions.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- A jackpot is a fixed slate of fixtures, one prediction each, a fixed entry
-- price, and a pooled prize shared by whoever gets the most right.
--
-- WHY THIS IS NOT A BET
-- A bet is priced: the customer knows their return when they place it. A
-- jackpot entry is not -- what it pays depends on how many other people also
-- got fourteen right, which nobody knows until the last match finishes. So it
-- gets its own tables rather than being forced through `bets`, whose entire
-- design assumes a locked price and a computable potential return.
--
-- Money still moves through the SAME wallet and ledger. The entry fee is an
-- ordinary debit and a prize is an ordinary credit; only the pricing model
-- differs.
--
-- WHAT THE OPERATOR CANNOT DO
-- The fixtures, the entry price and the prize structure are frozen once the
-- competition opens. An operator who could edit the slate after entries were
-- sold could change what people paid for, and a jackpot is exactly where that
-- temptation lives.

CREATE TYPE "jackpot_status" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'SETTLED', 'CANCELLED');
--> statement-breakpoint

CREATE TABLE "jackpots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "status" "jackpot_status" DEFAULT 'DRAFT' NOT NULL,

  "entry_fee_minor" bigint NOT NULL,
  -- What the operator puts in regardless of entries, so a competition with few
  -- entries still pays something.
  "guaranteed_prize_minor" bigint DEFAULT 0 NOT NULL,
  -- Share of entry fees that goes to the pool, in basis points. The remainder
  -- is the operator margin. Stated as a number so it can be shown to the
  -- player rather than being implicit in a calculation somewhere.
  "pool_contribution_basis_points" integer DEFAULT 7000 NOT NULL,

  "selection_count" integer NOT NULL,
  -- Fewest correct predictions that wins anything.
  "minimum_winning_hits" integer NOT NULL,

  "closes_at" timestamp(6) with time zone NOT NULL,
  "settled_at" timestamp(6) with time zone,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "jackpots_entry_fee_positive" CHECK ("entry_fee_minor" > 0),
  CONSTRAINT "jackpots_guarantee_nonnegative" CHECK ("guaranteed_prize_minor" >= 0),
  CONSTRAINT "jackpots_contribution_valid" CHECK (
    "pool_contribution_basis_points" BETWEEN 0 AND 10000
  ),
  CONSTRAINT "jackpots_selection_count_valid" CHECK ("selection_count" BETWEEN 3 AND 30),
  CONSTRAINT "jackpots_minimum_hits_valid" CHECK (
    "minimum_winning_hits" > 0 AND "minimum_winning_hits" <= "selection_count"
  )
);
--> statement-breakpoint

CREATE INDEX "jackpots_status_idx" ON "jackpots" ("status", "closes_at");
--> statement-breakpoint

-- The slate. One row per fixture, in a fixed order players see and refer to.
CREATE TABLE "jackpot_fixtures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "jackpot_id" uuid NOT NULL REFERENCES "jackpots"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "position" integer NOT NULL,
  -- Resolved from the event result once the fixture finishes.
  "outcome" text,

  CONSTRAINT "jackpot_fixtures_position_valid" CHECK ("position" >= 0),
  CONSTRAINT "jackpot_fixtures_outcome_valid" CHECK (
    "outcome" IS NULL OR "outcome" IN ('HOME', 'DRAW', 'AWAY')
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX "jackpot_fixtures_position_unique"
  ON "jackpot_fixtures" ("jackpot_id", "position");
--> statement-breakpoint
-- One fixture cannot appear twice on the same slate.
CREATE UNIQUE INDEX "jackpot_fixtures_event_unique"
  ON "jackpot_fixtures" ("jackpot_id", "event_id");
--> statement-breakpoint

CREATE TABLE "jackpot_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "jackpot_id" uuid NOT NULL REFERENCES "jackpots"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- One prediction per fixture, in slate order.
  "predictions" jsonb NOT NULL,

  -- The entry fee debit. UNIQUE, so one payment buys exactly one entry.
  "fee_txn_id" uuid NOT NULL
    REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Filled at settlement.
  "hits" integer,
  "prize_minor" bigint,
  "prize_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "jackpot_entries_predictions_is_array" CHECK (
    jsonb_typeof("predictions") = 'array'
  ),
  CONSTRAINT "jackpot_entries_hits_nonnegative" CHECK ("hits" IS NULL OR "hits" >= 0),
  CONSTRAINT "jackpot_entries_prize_nonnegative" CHECK (
    "prize_minor" IS NULL OR "prize_minor" >= 0
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX "jackpot_entries_fee_txn_unique" ON "jackpot_entries" ("fee_txn_id");
--> statement-breakpoint
CREATE INDEX "jackpot_entries_jackpot_idx" ON "jackpot_entries" ("jackpot_id", "hits" DESC);
--> statement-breakpoint
CREATE INDEX "jackpot_entries_user_idx" ON "jackpot_entries" ("user_id", "created_at" DESC);
--> statement-breakpoint

-- Once a competition is open, its terms are fixed. An operator able to edit the
-- slate, the price or the prize structure after entries were sold could change
-- what people paid for.
CREATE OR REPLACE FUNCTION "jackpots_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."entry_fee_minor" IS DISTINCT FROM OLD."entry_fee_minor"
       OR NEW."guaranteed_prize_minor" IS DISTINCT FROM OLD."guaranteed_prize_minor"
       OR NEW."pool_contribution_basis_points" IS DISTINCT FROM OLD."pool_contribution_basis_points"
       OR NEW."selection_count" IS DISTINCT FROM OLD."selection_count"
       OR NEW."minimum_winning_hits" IS DISTINCT FROM OLD."minimum_winning_hits"
       OR NEW."closes_at" IS DISTINCT FROM OLD."closes_at" THEN
      RAISE EXCEPTION 'jackpot % terms are fixed once it opens', OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "jackpots_guard_trigger"
  BEFORE UPDATE ON "jackpots"
  FOR EACH ROW EXECUTE FUNCTION "jackpots_guard"();
--> statement-breakpoint

-- The slate itself cannot change at all once published.
CREATE OR REPLACE FUNCTION "jackpot_fixtures_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."event_id" IS DISTINCT FROM OLD."event_id"
     OR NEW."position" IS DISTINCT FROM OLD."position"
     OR NEW."jackpot_id" IS DISTINCT FROM OLD."jackpot_id" THEN
    RAISE EXCEPTION 'jackpot fixture % cannot be changed', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  -- An outcome, once resolved, is evidence.
  IF OLD."outcome" IS NOT NULL AND NEW."outcome" IS DISTINCT FROM OLD."outcome" THEN
    RAISE EXCEPTION 'jackpot fixture % outcome is already resolved', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "jackpot_fixtures_guard_trigger"
  BEFORE UPDATE ON "jackpot_fixtures"
  FOR EACH ROW EXECUTE FUNCTION "jackpot_fixtures_guard"();
--> statement-breakpoint

-- An entry is a purchase. Its predictions cannot change after the fee is paid.
CREATE OR REPLACE FUNCTION "jackpot_entries_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."predictions" IS DISTINCT FROM OLD."predictions"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."jackpot_id" IS DISTINCT FROM OLD."jackpot_id"
     OR NEW."fee_txn_id" IS DISTINCT FROM OLD."fee_txn_id" THEN
    RAISE EXCEPTION 'jackpot entry % is immutable once paid for', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  IF OLD."prize_txn_id" IS NOT NULL AND NEW."prize_txn_id" IS DISTINCT FROM OLD."prize_txn_id" THEN
    RAISE EXCEPTION 'jackpot entry % has already been paid', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "jackpot_entries_guard_trigger"
  BEFORE UPDATE ON "jackpot_entries"
  FOR EACH ROW EXECUTE FUNCTION "jackpot_entries_guard"();
--> statement-breakpoint

GRANT USAGE ON TYPE "jackpot_status" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "jackpots", "jackpot_fixtures", "jackpot_entries" TO app_role;
