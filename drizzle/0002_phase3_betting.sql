-- Phase 3: bet placement — bets, bet legs, and per-market exposure.
--
-- Like the earlier migrations this carries constraints, triggers, and grants
-- that Drizzle's schema DSL cannot express. Run it only through the unpooled
-- owner/migration connection.

CREATE TYPE "bet_status" AS ENUM ('PENDING', 'WON', 'LOST', 'VOID', 'CASHED_OUT');
--> statement-breakpoint
CREATE TYPE "bet_leg_result" AS ENUM ('PENDING', 'WON', 'LOST', 'VOID');
--> statement-breakpoint

-- ============================================================================
-- BETS
-- ============================================================================

CREATE TABLE "bets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- INVARIANT 8, enforced structurally: a bet cannot exist without the ledger
  -- transaction that debited its stake. NOT NULL means "create bet, then
  -- debit" is not expressible; UNIQUE means two bets can never share one
  -- debit. The reverse leak (stake debited, no bet) is impossible because
  -- both rows are written in one transaction and roll back together.
  "stake_txn_id" uuid NOT NULL REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  "stake_minor" bigint NOT NULL,

  -- Display value, rounded half-up from the product of the leg odds.
  -- `potential_return_minor` is the authoritative payout and is derived from
  -- the leg odds directly, NOT from this column — deriving it from a rounded
  -- total would round twice and drift from what the user was quoted.
  "total_odds_decimal" numeric(12, 3) NOT NULL,
  "potential_return_minor" bigint NOT NULL,

  "status" "bet_status" DEFAULT 'PENDING' NOT NULL,
  "placed_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp(6) with time zone,

  CONSTRAINT "bets_stake_positive" CHECK ("stake_minor" > 0),
  CONSTRAINT "bets_odds_gt_one" CHECK ("total_odds_decimal" > 1),
  -- A winning bet must never return less than the stake.
  CONSTRAINT "bets_return_covers_stake" CHECK ("potential_return_minor" >= "stake_minor"),
  -- settled_at is set exactly when the bet leaves PENDING, never before.
  CONSTRAINT "bets_settled_at_matches_status" CHECK (
    ("status" = 'PENDING' AND "settled_at" IS NULL)
    OR ("status" <> 'PENDING' AND "settled_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bets_stake_txn_unique" ON "bets" ("stake_txn_id");
--> statement-breakpoint
CREATE INDEX "bets_user_placed_idx" ON "bets" ("user_id", "placed_at" DESC);
--> statement-breakpoint
CREATE INDEX "bets_pending_idx" ON "bets" ("status") WHERE "status" = 'PENDING';
--> statement-breakpoint

-- ============================================================================
-- BET LEGS  (a single is one leg; an accumulator is N)
-- ============================================================================

CREATE TABLE "bet_legs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bet_id" uuid NOT NULL REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "selection_id" uuid NOT NULL REFERENCES "selections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- INVARIANT 7: the price the user was shown, frozen here at placement.
  -- Settlement reads this, never selections.current_price_decimal.
  "locked_odds_decimal" numeric(7, 3) NOT NULL,

  "result" "bet_leg_result" DEFAULT 'PENDING' NOT NULL,
  "settled_at" timestamp(6) with time zone,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "bet_legs_odds_gt_one" CHECK ("locked_odds_decimal" > 1),
  CONSTRAINT "bet_legs_settled_at_matches_result" CHECK (
    ("result" = 'PENDING' AND "settled_at" IS NULL)
    OR ("result" <> 'PENDING' AND "settled_at" IS NOT NULL)
  )
);
--> statement-breakpoint
-- The same selection twice in one accumulator is a correlated bet priced as
-- if independent — reject it structurally rather than in a service check.
CREATE UNIQUE INDEX "bet_legs_bet_selection_unique" ON "bet_legs" ("bet_id", "selection_id");
--> statement-breakpoint
CREATE INDEX "bet_legs_bet_idx" ON "bet_legs" ("bet_id");
--> statement-breakpoint
-- Settlement's hot lookup: every unsettled leg riding on one selection.
CREATE INDEX "bet_legs_pending_selection_idx"
  ON "bet_legs" ("selection_id") WHERE "result" = 'PENDING';
--> statement-breakpoint

-- ============================================================================
-- EXPOSURE  (per-market liability ceiling)
-- ============================================================================

CREATE TABLE "exposure" (
  "market_id" uuid PRIMARY KEY REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "total_liability_minor" bigint DEFAULT 0 NOT NULL,
  -- No default, deliberately: an unbounded market is a book that cannot lose
  -- gracefully, so the ceiling must be supplied explicitly at creation.
  "ceiling_minor" bigint NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "exposure_liability_nonnegative" CHECK ("total_liability_minor" >= 0),
  CONSTRAINT "exposure_ceiling_positive" CHECK ("ceiling_minor" > 0),
  -- Backstop to the service-level check. The placement path rejects cleanly
  -- via a conditional UPDATE; this makes breaching the ceiling impossible
  -- even from a future code path that forgets to.
  CONSTRAINT "exposure_within_ceiling" CHECK ("total_liability_minor" <= "ceiling_minor")
);
--> statement-breakpoint

-- ============================================================================
-- STATE MACHINE + IMMUTABILITY GUARDS
-- ============================================================================

-- Legal transitions:
--   PENDING -> WON | LOST | VOID | CASHED_OUT
--   <terminal> -> (nothing, ever)
--
-- This is what makes settlement idempotent at the database level rather than
-- by convention: a duplicate or corrected result feed replaying a settlement
-- cannot move a bet that has already paid out (INVARIANT 9).
CREATE OR REPLACE FUNCTION bets_guard_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'bet % is already terminal (%) and cannot become %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- The placement facts are evidence. Nothing may rewrite the stake, the
  -- price, the payout, the owner, or the funding transaction after the fact —
  -- that is the difference between "logged" and "reproducible by an auditor".
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.stake_minor IS DISTINCT FROM OLD.stake_minor
     OR NEW.stake_txn_id IS DISTINCT FROM OLD.stake_txn_id
     OR NEW.total_odds_decimal IS DISTINCT FROM OLD.total_odds_decimal
     OR NEW.potential_return_minor IS DISTINCT FROM OLD.potential_return_minor
     OR NEW.placed_at IS DISTINCT FROM OLD.placed_at THEN
    RAISE EXCEPTION 'bet % placement facts are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bets_guard_transition_trigger
  BEFORE UPDATE ON "bets"
  FOR EACH ROW EXECUTE FUNCTION bets_guard_transition();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION bet_legs_guard_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.result <> 'PENDING' AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'bet leg % is already resolved (%) and cannot become %',
      OLD.id, OLD.result, NEW.result
      USING ERRCODE = 'check_violation';
  END IF;

  -- INVARIANT 7 at the database level: a bet settles against the price the
  -- user saw. If the locked price could be edited, "settled against stored
  -- odds" would be a statement about code, not about data.
  IF NEW.bet_id IS DISTINCT FROM OLD.bet_id
     OR NEW.selection_id IS DISTINCT FROM OLD.selection_id
     OR NEW.locked_odds_decimal IS DISTINCT FROM OLD.locked_odds_decimal THEN
    RAISE EXCEPTION 'bet leg % placement facts are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bet_legs_guard_transition_trigger
  BEFORE UPDATE ON "bet_legs"
  FOR EACH ROW EXECUTE FUNCTION bet_legs_guard_transition();
--> statement-breakpoint

-- A bet with no legs is not a bet. Deferred so legs may be inserted after the
-- header inside the same placement transaction.
CREATE OR REPLACE FUNCTION bets_require_legs() RETURNS trigger AS $$
DECLARE
  leg_count integer;
BEGIN
  SELECT count(*) INTO leg_count FROM bet_legs WHERE bet_id = NEW.id;
  IF leg_count = 0 THEN
    RAISE EXCEPTION 'bet % was committed with no legs', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER bets_require_legs_trigger
  AFTER INSERT ON "bets"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bets_require_legs();
--> statement-breakpoint

-- ============================================================================
-- GRANTS  (Phase 1 owner/runtime split)
-- ============================================================================

GRANT USAGE ON TYPE "bet_status", "bet_leg_result" TO app_role;
--> statement-breakpoint

-- Settlement flips status/result and stamps settled_at, so UPDATE is needed;
-- the triggers above bound what an UPDATE is allowed to change.
GRANT SELECT, INSERT, UPDATE ON TABLE "bets", "bet_legs" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "exposure" TO app_role;
--> statement-breakpoint

-- Bets are evidence of a money movement. They may be settled, never erased.
REVOKE DELETE, TRUNCATE ON TABLE "bets", "bet_legs" FROM app_role;
