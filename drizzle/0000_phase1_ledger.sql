-- Phase 1 baseline: users, append-only audit, wallets, and double-entry ledger.
--
-- This migration intentionally contains constraints, deferred triggers, role
-- grants, and seeds that cannot be represented completely by Drizzle's schema
-- DSL. Run it only through the unpooled owner/migration connection.

CREATE TYPE "user_role" AS ENUM ('USER', 'ADMIN');
--> statement-breakpoint
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'SELF_EXCLUDED');
--> statement-breakpoint
CREATE TYPE "actor_type" AS ENUM ('USER', 'ADMIN', 'SYSTEM');
--> statement-breakpoint
CREATE TYPE "wallet_currency" AS ENUM ('NGN');
--> statement-breakpoint
CREATE TYPE "wallet_kind" AS ENUM ('USER', 'SYSTEM');
--> statement-breakpoint
CREATE TYPE "system_account" AS ENUM (
  'CASH_IN',
  'CASH_OUT',
  'STAKES_LIABILITY',
  'PAYOUTS_PAYABLE',
  'BONUS_LIABILITY',
  'ADJUSTMENTS_EQUITY'
);
--> statement-breakpoint
CREATE TYPE "reconciliation_status" AS ENUM ('CLEAN', 'FLAGGED');
--> statement-breakpoint
CREATE TYPE "ledger_direction" AS ENUM ('DEBIT', 'CREDIT');
--> statement-breakpoint
CREATE TYPE "ledger_transaction_type" AS ENUM (
  'DEPOSIT',
  'WITHDRAWAL',
  'STAKE',
  'PAYOUT',
  'REFUND',
  'BONUS',
  'ADJUSTMENT',
  'TRANSFER'
);
--> statement-breakpoint

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" TEXT NOT NULL,
  "phone_number" TEXT,
  "password_hash" TEXT NOT NULL,
  "role" "user_role" DEFAULT 'USER' NOT NULL,
  "status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
  "must_change_password" BOOLEAN DEFAULT false NOT NULL,
  "kyc_level" INTEGER DEFAULT 0 NOT NULL,
  "created_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT "users_email_unique" UNIQUE ("email"),
  CONSTRAINT "users_email_canonical" CHECK (
    "email" = lower(btrim("email")) AND length("email") BETWEEN 3 AND 320
  ),
  CONSTRAINT "users_kyc_level_nonnegative" CHECK ("kyc_level" >= 0)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_user_status_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       (OLD."status" = 'ACTIVE' AND NEW."status" IN ('SUSPENDED', 'SELF_EXCLUDED'))
       OR (OLD."status" = 'SUSPENDED' AND NEW."status" IN ('ACTIVE', 'SELF_EXCLUDED'))
     ) THEN
    RAISE EXCEPTION 'illegal user status transition from % to %', OLD."status", NEW."status"
      USING ERRCODE = '23514',
            CONSTRAINT = 'users_status_transition_valid';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "users_status_transition_valid"
  BEFORE UPDATE OF "status" ON "users"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_user_status_transition"();
--> statement-breakpoint

CREATE TABLE "audit_log" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_type" "actor_type" NOT NULL,
  "actor_id" UUID,
  "action" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "reason" TEXT,
  "before" JSONB,
  "after" JSONB,
  "ip" INET,
  "creation_transaction_id" BIGINT DEFAULT (pg_current_xact_id()::text::bigint) NOT NULL,
  "created_at" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  CONSTRAINT "audit_log_actor_id_consistent" CHECK (
    ("actor_type" = 'SYSTEM' AND "actor_id" IS NULL)
    OR ("actor_type" <> 'SYSTEM' AND "actor_id" IS NOT NULL)
  ),
  CONSTRAINT "audit_log_admin_reason_valid" CHECK (
    "actor_type" <> 'ADMIN' OR (
      "reason" IS NOT NULL
      AND char_length("reason") <= 500
      AND char_length(regexp_replace("reason", '(^[[:space:]]+)|([[:space:]]+$)', '', 'g')) >= 3
    )
  ),
  CONSTRAINT "audit_log_non_system_ip_required" CHECK (
    "actor_type" = 'SYSTEM' OR "ip" IS NOT NULL
  )
);
--> statement-breakpoint
CREATE INDEX "audit_log_creation_transaction_id_idx"
  ON "audit_log" ("creation_transaction_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_current_audit_transaction"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."creation_transaction_id" <> pg_current_xact_id()::text::bigint THEN
    RAISE EXCEPTION 'audit evidence must identify its creating transaction'
      USING ERRCODE = '55000',
            CONSTRAINT = 'audit_log_creation_transaction_current';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_log_creation_transaction_current"
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_current_audit_transaction"();
--> statement-breakpoint

CREATE TABLE "wallets" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "wallet_kind" DEFAULT 'USER' NOT NULL,
  "user_id" UUID,
  "system_account" "system_account",
  "currency" "wallet_currency" DEFAULT 'NGN' NOT NULL,
  "cached_balance_minor" BIGINT DEFAULT 0,
  "version" BIGINT DEFAULT 0 NOT NULL,
  "reconciliation_status" "reconciliation_status" DEFAULT 'CLEAN' NOT NULL,
  "reconciliation_drift_minor" BIGINT DEFAULT 0 NOT NULL,
  "reconciliation_checked_at" TIMESTAMPTZ(6),
  "reconciliation_flagged_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  CONSTRAINT "wallets_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "wallets_kind_fields_consistent" CHECK (
    (
      "kind" = 'USER'
      AND "user_id" IS NOT NULL
      AND "system_account" IS NULL
      AND "cached_balance_minor" IS NOT NULL
    ) OR (
      "kind" = 'SYSTEM'
      AND "user_id" IS NULL
      AND "system_account" IS NOT NULL
      AND "cached_balance_minor" IS NULL
    )
  ),
  CONSTRAINT "wallets_cached_balance_nonnegative" CHECK (
    "cached_balance_minor" IS NULL OR "cached_balance_minor" >= 0
  ),
  CONSTRAINT "wallets_version_nonnegative" CHECK ("version" >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX "wallets_user_currency_unique"
  ON "wallets" ("user_id", "currency")
  WHERE "kind" = 'USER';
--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_system_currency_unique"
  ON "wallets" ("system_account", "currency")
  WHERE "kind" = 'SYSTEM';
--> statement-breakpoint

CREATE TABLE "ledger_transactions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" "ledger_transaction_type" NOT NULL,
  "reference" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "creation_transaction_id" BIGINT DEFAULT (pg_current_xact_id()::text::bigint) NOT NULL,
  "actor_type" "actor_type" NOT NULL,
  "actor_id" UUID,
  "metadata" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "created_at" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  CONSTRAINT "ledger_transactions_request_fingerprint_format" CHECK (
    "request_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ledger_transactions_actor_id_consistent" CHECK (
    ("actor_type" = 'SYSTEM' AND "actor_id" IS NULL)
    OR ("actor_type" <> 'SYSTEM' AND "actor_id" IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_unique"
  ON "ledger_transactions" ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_reference_unique"
  ON "ledger_transactions" ("reference")
  WHERE "reference" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "ledger_entries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "txn_id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "direction" "ledger_direction" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "balance_after_minor" BIGINT,
  "wallet_version" BIGINT,
  "created_at" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  CONSTRAINT "ledger_entries_txn_id_ledger_transactions_id_fk"
    FOREIGN KEY ("txn_id") REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk"
    FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount_minor" > 0),
  CONSTRAINT "ledger_entries_balance_after_nonnegative" CHECK (
    "balance_after_minor" IS NULL OR "balance_after_minor" >= 0
  ),
  CONSTRAINT "ledger_entries_wallet_state_paired" CHECK (
    ("balance_after_minor" IS NULL) = ("wallet_version" IS NULL)
  ),
  CONSTRAINT "ledger_entries_wallet_version_positive" CHECK (
    "wallet_version" IS NULL OR "wallet_version" > 0
  )
);
--> statement-breakpoint

CREATE INDEX "ledger_entries_wallet_statement_idx"
  ON "ledger_entries" ("wallet_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "ledger_entries_txn_idx" ON "ledger_entries" ("txn_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_wallet_version_unique"
  ON "ledger_entries" ("wallet_id", "wallet_version")
  WHERE "wallet_version" IS NOT NULL;
--> statement-breakpoint

-- A user wallet must enter the system at exactly zero. Funding always goes
-- through WalletService and therefore creates balanced ledger legs and audit
-- evidence; callers cannot manufacture an unexplained opening balance.
CREATE OR REPLACE FUNCTION "enforce_zero_opening_user_wallet"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."kind" = 'USER' AND NEW."cached_balance_minor" <> 0 THEN
    RAISE EXCEPTION 'user wallet % must open with a zero cached balance', NEW."id"
      USING ERRCODE = '23514',
            CONSTRAINT = 'wallets_user_zero_opening_balance';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "wallets_user_zero_opening_balance"
  BEFORE INSERT ON "wallets"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_zero_opening_user_wallet"();
--> statement-breakpoint

-- Seal transaction headers to the PostgreSQL transaction that created them,
-- and validate each leg against the wallet row while it is locked. This
-- prevents both retroactive balanced appends and malformed USER/SYSTEM legs.
CREATE OR REPLACE FUNCTION "validate_new_ledger_entry"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  header_xid BIGINT;
  target_kind "wallet_kind";
  current_balance BIGINT;
  current_version BIGINT;
  expected_balance BIGINT;
BEGIN
  SELECT "creation_transaction_id"
  INTO header_xid
  FROM "ledger_transactions"
  WHERE "id" = NEW."txn_id";

  IF header_xid IS NULL OR header_xid <> pg_current_xact_id()::text::bigint THEN
    RAISE EXCEPTION 'ledger transaction % is sealed', NEW."txn_id"
      USING ERRCODE = '55000',
            CONSTRAINT = 'ledger_entries_header_sealed';
  END IF;

  -- Only USER wallets carry mutable cached state. Avoid locking shared SYSTEM
  -- contra wallets, which would otherwise serialize unrelated transactions.
  SELECT "cached_balance_minor", "version"
  INTO current_balance, current_version
  FROM "wallets"
  WHERE "id" = NEW."wallet_id" AND "kind" = 'USER'
  FOR UPDATE;

  IF FOUND THEN
    IF NEW."balance_after_minor" IS NULL OR NEW."wallet_version" IS NULL THEN
      RAISE EXCEPTION 'user-wallet ledger legs require balance_after_minor and wallet_version'
        USING ERRCODE = '23514',
              CONSTRAINT = 'ledger_entries_user_state_required';
    END IF;

    expected_balance := CASE NEW."direction"
      WHEN 'CREDIT' THEN current_balance + NEW."amount_minor"
      ELSE current_balance - NEW."amount_minor"
    END;

    IF expected_balance < 0
       OR NEW."balance_after_minor" <> expected_balance
       OR NEW."wallet_version" <> current_version + 1 THEN
      RAISE EXCEPTION
        'ledger leg does not match locked wallet %: balance %, version %',
        NEW."wallet_id", expected_balance, current_version + 1
        USING ERRCODE = '23514',
              CONSTRAINT = 'ledger_entries_user_state_valid';
    END IF;

  ELSE
    SELECT "kind"
    INTO target_kind
    FROM "wallets"
    WHERE "id" = NEW."wallet_id";

    IF target_kind = 'SYSTEM' THEN
    IF NEW."balance_after_minor" IS NOT NULL OR NEW."wallet_version" IS NOT NULL THEN
      RAISE EXCEPTION 'system-wallet ledger legs cannot carry cached balance state'
          USING ERRCODE = '23514',
                CONSTRAINT = 'ledger_entries_system_state_forbidden';
      END IF;
    ELSE
      RAISE EXCEPTION 'wallet % does not exist', NEW."wallet_id"
        USING ERRCODE = '23503',
              CONSTRAINT = 'ledger_entries_wallet_id_wallets_id_fk';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_validate_before_insert"
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW
  EXECUTE FUNCTION "validate_new_ledger_entry"();
--> statement-breakpoint

-- SUM(BIGINT) returns NUMERIC in Postgres. Keep the PL/pgSQL variables
-- NUMERIC too: a high-volume ledger can have lifetime debit/credit totals
-- greater than int8 even though each individual amount and wallet balance is
-- within int8.
CREATE OR REPLACE FUNCTION "assert_ledger_transaction_balanced"(
  checked_txn_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  entry_count BIGINT;
  debit_count BIGINT;
  credit_count BIGINT;
  debit_sum NUMERIC;
  credit_sum NUMERIC;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE "direction" = 'DEBIT'),
    count(*) FILTER (WHERE "direction" = 'CREDIT'),
    COALESCE(sum("amount_minor"::NUMERIC) FILTER (WHERE "direction" = 'DEBIT'), 0),
    COALESCE(sum("amount_minor"::NUMERIC) FILTER (WHERE "direction" = 'CREDIT'), 0)
  INTO entry_count, debit_count, credit_count, debit_sum, credit_sum
  FROM "ledger_entries"
  WHERE "txn_id" = checked_txn_id;

  IF entry_count < 2 OR debit_count = 0 OR credit_count = 0 OR debit_sum <> credit_sum THEN
    RAISE EXCEPTION
      'ledger transaction % is unbalanced: entries=%, debits=% (%), credits=% (%)',
      checked_txn_id, entry_count, debit_count, debit_sum, credit_count, credit_sum
      USING ERRCODE = '23514',
            CONSTRAINT = 'ledger_transaction_balanced';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "check_ledger_transaction_header_integrity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "assert_ledger_transaction_balanced"(NEW."id");

  IF NOT EXISTS (
    SELECT 1
    FROM "audit_log" AS audit
    WHERE audit."creation_transaction_id" = NEW."creation_transaction_id"
      AND audit."actor_type" = NEW."actor_type"
      AND audit."actor_id" IS NOT DISTINCT FROM NEW."actor_id"
      AND (
        (
          audit."action" IN ('WALLET_CREDIT', 'WALLET_DEBIT')
          AND audit."entity" = 'WALLET'
          AND audit."after" ->> 'transactionId' = NEW."id"::text
        )
        OR (
          audit."action" = 'WALLET_TRANSFER'
          AND audit."entity" = 'LEDGER_TRANSACTION'
          AND audit."entity_id" = NEW."id"::text
        )
      )
  ) THEN
    RAISE EXCEPTION 'ledger transaction % has no matching same-transaction audit evidence', NEW."id"
      USING ERRCODE = '23514',
            CONSTRAINT = 'ledger_transaction_audit_required';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- The header trigger is essential: an entry-only trigger never fires for an
-- accidentally committed transaction header with zero ledger legs.
CREATE CONSTRAINT TRIGGER "ledger_transaction_header_integrity_at_commit"
  AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "check_ledger_transaction_header_integrity"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "check_ledger_entry_balance"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  committed_balance BIGINT;
  committed_version BIGINT;
BEGIN
  PERFORM "assert_ledger_transaction_balanced"(NEW."txn_id");

  IF NEW."wallet_version" IS NOT NULL THEN
    SELECT "cached_balance_minor", "version"
    INTO committed_balance, committed_version
    FROM "wallets"
    WHERE "id" = NEW."wallet_id";

    IF committed_balance <> NEW."balance_after_minor"
       OR committed_version <> NEW."wallet_version" THEN
      RAISE EXCEPTION
        'wallet % cache/version was not committed with ledger transaction %',
        NEW."wallet_id", NEW."txn_id"
        USING ERRCODE = '23514',
              CONSTRAINT = 'ledger_entries_cache_committed';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- This second trigger also protects an already-existing transaction from a
-- later unbalanced append. Both checks run at COMMIT, after all legs exist.
CREATE CONSTRAINT TRIGGER "ledger_entries_balanced_at_commit"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "check_ledger_entry_balance"();
--> statement-breakpoint

-- Changing cached money state must be explained by a USER-wallet ledger leg
-- created in this exact transaction. Reconciliation-only updates do not fire.
CREATE OR REPLACE FUNCTION "check_wallet_ledger_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ledger_entries" AS entry
    INNER JOIN "ledger_transactions" AS header ON header."id" = entry."txn_id"
    WHERE entry."wallet_id" = NEW."id"
      AND entry."balance_after_minor" = NEW."cached_balance_minor"
      AND entry."wallet_version" = NEW."version"
      AND header."creation_transaction_id" = pg_current_xact_id()::text::bigint
  ) THEN
    RAISE EXCEPTION 'wallet % cache/version update has no matching same-transaction ledger leg', NEW."id"
      USING ERRCODE = '23514',
            CONSTRAINT = 'wallets_ledger_state_committed';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "wallets_ledger_state_at_commit"
  AFTER UPDATE OF "cached_balance_minor", "version" ON "wallets"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    OLD."cached_balance_minor" IS DISTINCT FROM NEW."cached_balance_minor"
    OR OLD."version" IS DISTINCT FROM NEW."version"
  )
  EXECUTE FUNCTION "check_wallet_ledger_state"();
--> statement-breakpoint

-- Permissions provide the expected runtime `permission denied`; triggers are
-- an owner-level backstop and reject even zero-row UPDATE/DELETE statements.
CREATE OR REPLACE FUNCTION "reject_immutable_table_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "ledger_transactions_immutable"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "ledger_transactions"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "reject_immutable_table_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_immutable"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "reject_immutable_table_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audit_log_immutable"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_log"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "reject_immutable_table_mutation"();
--> statement-breakpoint

INSERT INTO "wallets" (
  "kind", "user_id", "system_account", "currency", "cached_balance_minor"
) VALUES
  ('SYSTEM', NULL, 'CASH_IN',            'NGN', NULL),
  ('SYSTEM', NULL, 'CASH_OUT',           'NGN', NULL),
  ('SYSTEM', NULL, 'STAKES_LIABILITY',   'NGN', NULL),
  ('SYSTEM', NULL, 'PAYOUTS_PAYABLE',    'NGN', NULL),
  ('SYSTEM', NULL, 'BONUS_LIABILITY',    'NGN', NULL),
  ('SYSTEM', NULL, 'ADJUSTMENTS_EQUITY', 'NGN', NULL);
--> statement-breakpoint

-- `app_role` is a non-login group role. Production DATABASE_URL and
-- DIRECT_DATABASE_URL credentials are members of it; MIGRATION_DATABASE_URL
-- uses a separate owner login. A table owner would bypass these revocations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_role;
--> statement-breakpoint
GRANT USAGE ON TYPE
  "user_role",
  "user_status",
  "actor_type",
  "wallet_currency",
  "wallet_kind",
  "system_account",
  "reconciliation_status",
  "ledger_direction",
  "ledger_transaction_type"
TO app_role;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "users" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "wallets" TO app_role;
--> statement-breakpoint
GRANT UPDATE (
  "cached_balance_minor",
  "version",
  "reconciliation_status",
  "reconciliation_drift_minor",
  "reconciliation_checked_at",
  "reconciliation_flagged_at",
  "updated_at"
) ON TABLE "wallets" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "ledger_transactions",
  "ledger_entries",
  "audit_log"
TO app_role;
--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  "ledger_transactions",
  "ledger_entries",
  "audit_log"
FROM app_role;
