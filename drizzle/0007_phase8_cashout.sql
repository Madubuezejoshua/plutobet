-- Cash-out: settling a bet early for a value derived from current prices.
--
-- Run only through the unpooled owner/migration connection.

-- The ledger transaction that paid the cash-out. UNIQUE so one bet can never
-- be cashed out twice, mirroring stake_txn_id — the constraint, not the
-- service, is what makes a retried request safe.
ALTER TABLE "bets" ADD COLUMN "cashout_txn_id" uuid
  REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "cashout_value_minor" bigint;
--> statement-breakpoint
CREATE UNIQUE INDEX "bets_cashout_txn_unique"
  ON "bets" ("cashout_txn_id") WHERE "cashout_txn_id" IS NOT NULL;
--> statement-breakpoint

-- A cashed-out bet paid a value, and nothing else did.
ALTER TABLE "bets" ADD CONSTRAINT "bets_cashout_matches_status" CHECK (
  ("status" = 'CASHED_OUT' AND "cashout_txn_id" IS NOT NULL AND "cashout_value_minor" IS NOT NULL)
  OR ("status" <> 'CASHED_OUT' AND "cashout_txn_id" IS NULL AND "cashout_value_minor" IS NULL)
);
--> statement-breakpoint

-- Cash-out must never pay more than the bet could have won. Without this a
-- pricing bug becomes an unbounded payout rather than a wrong one.
ALTER TABLE "bets" ADD CONSTRAINT "bets_cashout_within_potential" CHECK (
  "cashout_value_minor" IS NULL OR "cashout_value_minor" <= "potential_return_minor"
);
--> statement-breakpoint

-- The existing transition guard already freezes the placement facts and
-- refuses any move out of a terminal state, so CASHED_OUT is one-way and the
-- cash-out leg cannot be re-pointed. Extend it to cover the new column.
CREATE OR REPLACE FUNCTION bets_guard_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'bet % is already terminal (%) and cannot become %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.stake_minor IS DISTINCT FROM OLD.stake_minor
     OR NEW.stake_txn_id IS DISTINCT FROM OLD.stake_txn_id
     OR NEW.total_odds_decimal IS DISTINCT FROM OLD.total_odds_decimal
     OR NEW.potential_return_minor IS DISTINCT FROM OLD.potential_return_minor
     OR NEW.placed_at IS DISTINCT FROM OLD.placed_at THEN
    RAISE EXCEPTION 'bet % placement facts are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.cashout_txn_id IS NOT NULL
     AND NEW.cashout_txn_id IS DISTINCT FROM OLD.cashout_txn_id THEN
    RAISE EXCEPTION 'bet % cash-out is immutable once paid', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
