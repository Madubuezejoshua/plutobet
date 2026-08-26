-- Phase 1: ledger & wallets.
-- Requires PostgreSQL 13+ (gen_random_uuid() is built into core, no extension needed).

-- ============================================================================
-- USERS (minimal stub — expanded in the auth phase)
-- ============================================================================

CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE wallet_currency AS ENUM ('NGN');

-- 'user'  = a real user's spendable balance. Non-negative, pessimistically
--           locked on every write, cached_balance_minor is authoritative.
-- 'house' = the counter-party for every transaction (see note below).
--           Never locked, never has an authoritative cached balance.
CREATE TYPE wallet_kind AS ENUM ('user', 'house');

-- The fixed set of house/system accounts. One row per (account, currency) —
-- enough to give every transaction type a valid counter-party. Extend this
-- enum (and seed a row) when a later phase introduces a new money flow;
-- never repurpose an existing account for something it doesn't mean.
CREATE TYPE house_account AS ENUM (
  'cash_in',            -- contra side of deposits (represents the PSP/bank)
  'cash_out',            -- contra side of withdrawals
  'stakes_liability',    -- contra side of stake debits (what the house owes bettors)
  'payouts_payable',     -- contra side of winning-bet payouts
  'bonus_liability',     -- contra side of bonus credits
  'adjustments_equity'   -- contra side of manual admin adjustments
);

CREATE TYPE ledger_direction AS ENUM ('debit', 'credit');

CREATE TYPE transaction_type AS ENUM (
  'deposit', 'withdrawal', 'stake', 'payout', 'refund', 'bonus', 'adjustment', 'transfer'
);

CREATE TYPE actor_type AS ENUM ('user', 'admin', 'system');

-- ============================================================================
-- WALLETS
-- ============================================================================

CREATE TABLE wallets (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind     wallet_kind NOT NULL DEFAULT 'user',

  user_id       UUID REFERENCES users(id),   -- required iff kind = 'user'
  house_account house_account,               -- required iff kind = 'house'

  currency wallet_currency NOT NULL DEFAULT 'NGN',

  -- Authoritative ONLY for kind = 'user' (written inside the same DB
  -- transaction as the ledger rows that produced it, under FOR UPDATE).
  -- NULL for kind = 'house' — deliberately, not a frozen 0 — so nothing can
  -- mistake "we never maintain this" for a real value. House balances are
  -- always derived on demand from ledger_entries. See WalletService
  -- concurrency notes for why.
  cached_balance_minor BIGINT,

  -- Bumped on every cached_balance_minor write. Not used for locking
  -- (we use SELECT ... FOR UPDATE) — used by the reconciliation job to
  -- detect "this wallet was touched while I was replaying it, retry"
  -- without holding a lock for the whole replay.
  version BIGINT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_kind_fields_consistent CHECK (
    (kind = 'user'  AND user_id IS NOT NULL AND house_account IS NULL) OR
    (kind = 'house' AND user_id IS NULL     AND house_account IS NOT NULL)
  ),

  -- Ties the two nullability rules together: user wallets always have a
  -- real, non-negative cached balance; house wallets never have one at all.
  CONSTRAINT balance_presence_matches_kind CHECK (
    (kind = 'user'  AND cached_balance_minor IS NOT NULL AND cached_balance_minor >= 0) OR
    (kind = 'house' AND cached_balance_minor IS NULL)
  )
);

CREATE UNIQUE INDEX uq_wallets_user
  ON wallets (user_id, currency) WHERE kind = 'user';

CREATE UNIQUE INDEX uq_wallets_house
  ON wallets (house_account, currency) WHERE kind = 'house';

-- ============================================================================
-- TRANSACTIONS  (the "header" row for one balanced group of ledger entries)
-- ============================================================================

CREATE TABLE transactions (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type transaction_type NOT NULL,

  -- Our own dedup key. ALWAYS required — every WalletService call takes one.
  -- For externally-triggered money movement this is typically derived from
  -- the provider reference (e.g. "paystack:ref_xxx"); for internal ops it's
  -- caller-chosen (e.g. "stake:{betId}", "payout:{betId}").
  idempotency_key TEXT NOT NULL,

  -- Raw external provider reference, kept separately for reconciliation /
  -- support lookups. NULL for purely internal transactions.
  reference TEXT,

  actor_type actor_type NOT NULL,
  actor_id   UUID,  -- NULL when actor_type = 'system'

  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT actor_id_required_unless_system CHECK (
    (actor_type = 'system' AND actor_id IS NULL) OR
    (actor_type != 'system' AND actor_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_transactions_idempotency_key ON transactions (idempotency_key);
CREATE UNIQUE INDEX uq_transactions_reference ON transactions (reference) WHERE reference IS NOT NULL;

-- ============================================================================
-- LEDGER ENTRIES  (append-only, immutable — this IS the audit trail for money)
-- ============================================================================

CREATE TABLE ledger_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  wallet_id      UUID NOT NULL REFERENCES wallets(id),
  direction      ledger_direction NOT NULL,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),

  -- Authoritative post-entry balance for 'user' wallets (computed under
  -- FOR UPDATE, so it's exact). NULL for 'house' wallets — see wallets.
  balance_after_minor BIGINT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_entries_wallet ON ledger_entries (wallet_id, created_at);
CREATE INDEX idx_ledger_entries_transaction ON ledger_entries (transaction_id);

-- No UPDATE/DELETE path is exposed by the application, and this backstops it:
-- ledger rows are immutable once written.
CREATE RULE ledger_entries_no_update AS ON UPDATE TO ledger_entries DO INSTEAD NOTHING;
CREATE RULE ledger_entries_no_delete AS ON DELETE TO ledger_entries DO INSTEAD NOTHING;

-- ----------------------------------------------------------------------------
-- THE INVARIANT: every transaction's ledger entries balance to zero
-- (sum of debits == sum of credits). Postgres CHECK constraints can't see
-- other rows, so this has to be a constraint trigger. It's DEFERRED to
-- transaction commit so it doesn't matter what order the legs are inserted
-- in — by the time it actually runs, all of a transaction's legs are in.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_transaction_balances() RETURNS trigger AS $$
DECLARE
  debit_sum  BIGINT;
  credit_sum BIGINT;
BEGIN
  SELECT
    COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)
  INTO debit_sum, credit_sum
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  IF debit_sum <> credit_sum THEN
    RAISE EXCEPTION 'transaction % does not balance: debits=% credits=%',
      NEW.transaction_id, debit_sum, credit_sum;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_transaction_balances
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_transaction_balances();

-- ============================================================================
-- SEED — one house wallet per account. These never move after creation.
-- ============================================================================

INSERT INTO wallets (kind, house_account, currency) VALUES
  ('house', 'cash_in',            'NGN'),
  ('house', 'cash_out',           'NGN'),
  ('house', 'stakes_liability',   'NGN'),
  ('house', 'payouts_payable',    'NGN'),
  ('house', 'bonus_liability',    'NGN'),
  ('house', 'adjustments_equity', 'NGN');
-- Archived pre-migration Prisma SQL; excluded from the active build.
