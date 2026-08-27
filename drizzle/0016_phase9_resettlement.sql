-- Phase 9: resettlement, and partial cash-out.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- WHY RESETTLEMENT NEEDS ITS OWN MACHINERY
-- Results are wrong sometimes: a provider posts the wrong score, a match is
-- awarded after an appeal, a goal is disallowed hours later. Until now the
-- only way to correct a settled bet was manual surgery on the ledger, which is
-- exactly what the ledger is built to make impossible.
--
-- THE PRINCIPLE
-- A resettlement never edits the original. It records what was settled, what
-- it should have been, and posts COMPENSATING ledger entries.
--
-- That means a customer who was wrongly paid is debited and one who was
-- wrongly denied is credited, and both movements are ordinary double-entry
-- transactions carrying their own reason. The original settlement stays in the
-- record exactly as it happened, because "we paid this, then corrected it" is
-- the answer a regulator wants, and "we never paid it" is a lie.

CREATE TYPE "resettlement_reason" AS ENUM (
  'PROVIDER_CORRECTION',   -- the feed sent a corrected score
  'MATCH_AWARDED',         -- decided off the pitch, after an appeal
  'OPERATOR_ERROR',        -- we settled against the wrong market or line
  'VOIDED_AFTER_SETTLEMENT'
);
--> statement-breakpoint

CREATE TABLE "bet_resettlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bet_id" uuid NOT NULL REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- What the bet was, and what it becomes. Both recorded, so the correction is
  -- legible without replaying the ledger.
  "previous_status" "bet_status" NOT NULL,
  "new_status" "bet_status" NOT NULL,
  "previous_payout_minor" bigint NOT NULL,
  "new_payout_minor" bigint NOT NULL,

  -- The compensating movement. Positive means the customer is owed more;
  -- negative means they were overpaid and are being debited back.
  "adjustment_minor" bigint NOT NULL,
  "adjustment_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  "reason" "resettlement_reason" NOT NULL,
  -- Free text on top of the enum: the category is for reporting, the note is
  -- for the human who has to explain it to the customer.
  "note" text NOT NULL,

  -- Who authorised it. NOT NULL for the same reason admin money actions carry
  -- one: a correction nobody is accountable for is the one that turns up in an
  -- incident report with no explanation.
  "authorised_by" uuid NOT NULL REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "bet_resettlements_note_meaningful" CHECK (
    char_length(btrim("note")) BETWEEN 3 AND 500
  ),
  CONSTRAINT "bet_resettlements_payouts_nonnegative" CHECK (
    "previous_payout_minor" >= 0 AND "new_payout_minor" >= 0
  ),
  -- The adjustment must be exactly the difference. If these disagree, the
  -- ledger movement does not follow from the correction being claimed.
  CONSTRAINT "bet_resettlements_adjustment_is_difference" CHECK (
    "adjustment_minor" = "new_payout_minor" - "previous_payout_minor"
  ),
  -- A resettlement that changes nothing is not a resettlement.
  CONSTRAINT "bet_resettlements_changes_something" CHECK (
    "previous_status" IS DISTINCT FROM "new_status"
    OR "previous_payout_minor" IS DISTINCT FROM "new_payout_minor"
  )
);
--> statement-breakpoint

CREATE INDEX "bet_resettlements_bet_idx" ON "bet_resettlements" ("bet_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "bet_resettlements_created_idx" ON "bet_resettlements" ("created_at" DESC);
--> statement-breakpoint

-- A correction is evidence. Correcting a correction is a NEW row, which is
-- what preserves the sequence of what was believed when.
CREATE OR REPLACE FUNCTION "bet_resettlements_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'resettlement % is immutable', OLD."id"
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "bet_resettlements_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "bet_resettlements"
  FOR EACH ROW EXECUTE FUNCTION "bet_resettlements_immutable"();
--> statement-breakpoint

-- ============================================================================
-- BETS
-- ============================================================================

-- A settled bet is normally terminal, and the settlement path relies on that:
-- it refuses to act on anything that is not PENDING, which is what stops a
-- replayed feed paying twice.
--
-- Resettlement is the ONE sanctioned way past that, so it is recorded on the
-- row rather than inferred. A bet with a resettlement count above zero has
-- been corrected, and every screen that shows it should say so.
ALTER TABLE "bets" ADD COLUMN "resettlement_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "bets" ADD CONSTRAINT "bets_resettlement_count_nonnegative" CHECK (
  "resettlement_count" >= 0
);
--> statement-breakpoint

-- The terminal-status guard from 0002 refuses ANY transition out of a settled
-- bet, which is exactly what stops a replayed result feed from paying twice.
-- It must keep doing that.
--
-- So resettlement does not disable the guard or take a flag that says "trust
-- me". It EARNS the exception: a terminal transition is permitted only when a
-- bet_resettlements row for this bet is written by the SAME transaction, which
-- the trigger verifies via pg_current_xact_id().
--
-- The consequence is the point. It is not possible to re-settle a bet without
-- simultaneously recording who authorised it, why, and what it was before. The
-- audit trail is not a convention the service is trusted to follow; it is the
-- precondition for the write succeeding at all.
--
-- Same technique the ledger already uses to prove audit evidence was appended
-- by the transaction that wrote the money.
ALTER TABLE "bet_resettlements" ADD COLUMN "creation_transaction_id" bigint
  DEFAULT (pg_current_xact_id()::text::bigint) NOT NULL;
--> statement-breakpoint

CREATE INDEX "bet_resettlements_creation_txn_idx"
  ON "bet_resettlements" ("bet_id", "creation_transaction_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION bets_guard_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- Permitted only alongside a resettlement recorded by this transaction.
    IF NOT EXISTS (
      SELECT 1 FROM "bet_resettlements" r
      WHERE r."bet_id" = OLD.id
        AND r."creation_transaction_id" = pg_current_xact_id()::text::bigint
    ) THEN
      RAISE EXCEPTION 'bet % is already terminal (%) and cannot become %',
        OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The placement facts are evidence. Nothing may rewrite the stake, the
  -- price, the payout, the owner, or the funding transaction after the fact --
  -- that is the difference between "logged" and "reproducible by an auditor".
  -- Resettlement changes the OUTCOME, never these.
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

-- ============================================================================
-- PARTIAL CASH-OUT
-- ============================================================================

-- Cashing out PART of a bet: take some value now, leave the rest running.
--
-- Modelled as a reduction of the stake still at risk rather than as a new bet.
-- The alternative -- splitting into two bets -- would double the rows on every
-- partial and make the customer's history unreadable.
--
-- `cashed_out_stake_minor` is how much of the original stake has been bought
-- back. Settlement pays out on what remains, so a bet that is half cashed out
-- settles for half.
ALTER TABLE "bets" ADD COLUMN "cashed_out_stake_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "bets" ADD CONSTRAINT "bets_cashed_out_stake_valid" CHECK (
  "cashed_out_stake_minor" >= 0 AND "cashed_out_stake_minor" <= "stake_minor"
);
--> statement-breakpoint

-- Every partial, so the customer can see what they took and when.
CREATE TABLE "bet_cashouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bet_id" uuid NOT NULL REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- How much of the ORIGINAL stake this instalment bought back.
  "stake_portion_minor" bigint NOT NULL,
  -- What was paid for it.
  "paid_minor" bigint NOT NULL,
  "txn_id" uuid NOT NULL REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "bet_cashouts_stake_portion_positive" CHECK ("stake_portion_minor" > 0),
  CONSTRAINT "bet_cashouts_paid_positive" CHECK ("paid_minor" > 0)
);
--> statement-breakpoint

-- One ledger transaction pays for exactly one cash-out instalment. Without
-- this, a retried request could record the same payment twice against the bet.
CREATE UNIQUE INDEX "bet_cashouts_txn_unique" ON "bet_cashouts" ("txn_id");
--> statement-breakpoint
CREATE INDEX "bet_cashouts_bet_idx" ON "bet_cashouts" ("bet_id", "created_at");
--> statement-breakpoint

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT USAGE ON TYPE "resettlement_reason" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bet_resettlements", "bet_cashouts" TO app_role;
--> statement-breakpoint
-- Resettlement and partial cash-out both write to bets; UPDATE is already
-- granted there by 0002.
