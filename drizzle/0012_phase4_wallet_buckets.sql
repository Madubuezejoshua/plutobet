-- Phase 4: balance segregation — cash, bonus, and locked.
--
-- WHY A ROW PER BUCKET, NOT COLUMNS PER BUCKET
--
-- The obvious change is to add `bonus_balance_minor` and `locked_balance_minor`
-- to `wallets`. It is also the wrong one, and dangerously so.
--
-- Every guarantee this ledger makes is attached to ONE column on ONE row:
--
--   * validate_new_ledger_entry() locks the wallet row and requires each leg's
--     balance_after_minor and wallet_version to match `cached_balance_minor`
--     exactly.
--   * ledger_entries_balanced_at_commit and wallets_ledger_state_at_commit
--     replay the entries at commit and reject any divergence.
--
-- A second balance column would be covered by NONE of that. It would be
-- ordinary mutable state that the application increments by hand, drifting
-- silently the first time a code path forgot it — which is precisely the class
-- of bug this schema was built to make impossible.
--
-- So a bucket is a wallet row. Each one carries its own cached balance and
-- version, is validated by the existing triggers unchanged, reconciles
-- independently under the existing reconciliation job, and money moves between
-- buckets through `transfer()` — which already locks two wallets in UUID order
-- to avoid deadlock. Zero new invariant machinery, and the parts most likely
-- to be got wrong are the parts already proven.
--
-- The cost is two extra rows per account. That is the cheapest correctness
-- anybody has ever been offered.

CREATE TYPE "wallet_bucket" AS ENUM ('CASH', 'BONUS', 'LOCKED');
--> statement-breakpoint

-- Nullable, because SYSTEM wallets have no bucket — the same shape as
-- `cached_balance_minor`, which is also USER-only. The check below makes the
-- pairing structural rather than a convention.
ALTER TABLE "wallets" ADD COLUMN "bucket" "wallet_bucket";
--> statement-breakpoint

-- Every wallet that exists today is spendable cash.
UPDATE "wallets" SET "bucket" = 'CASH' WHERE "kind" = 'USER';
--> statement-breakpoint

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_bucket_matches_kind" CHECK (
  ("kind" = 'USER' AND "bucket" IS NOT NULL)
  OR ("kind" = 'SYSTEM' AND "bucket" IS NULL)
);
--> statement-breakpoint

-- One wallet per (account, currency, bucket). Replaces the old
-- (account, currency) key, which is what made a second bucket impossible.
DROP INDEX IF EXISTS "wallets_user_currency_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_currency_bucket_unique"
  ON "wallets" ("user_id", "currency", "bucket")
  WHERE "kind" = 'USER';
--> statement-breakpoint

-- The hot lookup: "this account's cash wallet", on every authenticated page.
CREATE INDEX "wallets_user_bucket_idx" ON "wallets" ("user_id", "bucket")
  WHERE "kind" = 'USER';
--> statement-breakpoint

-- ============================================================================
-- BACKFILL
-- ============================================================================

-- Bonus and locked wallets for every existing account, opening at zero.
--
-- Created eagerly rather than on first use. Lazy creation inside a money
-- transaction means a race between two concurrent credits, both finding no
-- row and both inserting — which the unique index would turn into a failed
-- deposit. Two empty rows are cheaper than that conversation.
INSERT INTO "wallets" ("kind", "user_id", "currency", "bucket", "cached_balance_minor")
SELECT 'USER', "user_id", "currency", bucket_kind, 0
FROM "wallets"
CROSS JOIN (VALUES ('BONUS'::"wallet_bucket"), ('LOCKED'::"wallet_bucket")) AS b(bucket_kind)
WHERE "kind" = 'USER' AND "bucket" = 'CASH'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- A BONUS BALANCE IS NOT CASH
-- ============================================================================

-- Bonus money is promotional credit with wagering conditions attached; it is
-- not the customer's money until those are met. Paying it out as if it were is
-- both a direct loss and, in a licensed operation, a misrepresentation of what
-- the balance meant.
--
-- Withdrawal already debits a wallet id supplied by the caller, so nothing
-- structural stopped a future code path from passing the bonus wallet. This
-- makes that a database-level refusal rather than a convention someone has to
-- remember.
CREATE OR REPLACE FUNCTION "reject_non_cash_withdrawal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_bucket "wallet_bucket";
  txn_type "ledger_transaction_type";
BEGIN
  IF NEW."direction" <> 'DEBIT' THEN
    RETURN NEW;
  END IF;

  SELECT "type" INTO txn_type FROM "ledger_transactions" WHERE "id" = NEW."txn_id";
  IF txn_type <> 'WITHDRAWAL' THEN
    RETURN NEW;
  END IF;

  SELECT "bucket" INTO source_bucket FROM "wallets" WHERE "id" = NEW."wallet_id";

  -- NULL bucket means a SYSTEM wallet, which is the legitimate counterparty
  -- leg of a withdrawal and must pass.
  IF source_bucket IS NOT NULL AND source_bucket <> 'CASH' THEN
    RAISE EXCEPTION 'withdrawals may only debit a CASH wallet, not %', source_bucket
      USING ERRCODE = '23514',
            CONSTRAINT = 'ledger_entries_withdrawal_cash_only';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "ledger_entries_withdrawal_cash_only"
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_non_cash_withdrawal"();
--> statement-breakpoint

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT USAGE ON TYPE "wallet_bucket" TO app_role;
