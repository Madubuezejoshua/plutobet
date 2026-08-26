-- Phase 5: payments, withdrawals, KYC, self-exclusion.
--
-- Run only through the unpooled owner/migration connection.

CREATE TYPE "payment_intent_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED');
--> statement-breakpoint
CREATE TYPE "withdrawal_status" AS ENUM (
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PROCESSING',
  'PAID',
  'FAILED'
);
--> statement-breakpoint
CREATE TYPE "kyc_provider" AS ENUM ('DOJAH', 'PAYSTACK', 'MANUAL');
--> statement-breakpoint

-- ============================================================================
-- DEPOSITS
-- ============================================================================

CREATE TABLE "payment_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "provider" text NOT NULL,

  -- THE idempotency anchor. Payment providers resend webhooks aggressively;
  -- this unique constraint is what makes "fired ten times, credited once"
  -- a property of the database rather than of the handler's care.
  "provider_ref" text NOT NULL,

  "amount_minor" bigint NOT NULL,
  "status" "payment_intent_status" DEFAULT 'PENDING' NOT NULL,

  -- The ledger transaction that credited this deposit. NULL until the money
  -- actually lands. UNIQUE so one provider reference can never fund two
  -- credits, mirroring bets.stake_txn_id.
  "credited_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Kept verbatim for dispute resolution and regulator questions.
  "raw_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "payment_intents_amount_positive" CHECK ("amount_minor" > 0),
  -- A succeeded deposit must point at its credit; anything else must not.
  CONSTRAINT "payment_intents_credit_matches_status" CHECK (
    ("status" = 'SUCCEEDED' AND "credited_txn_id" IS NOT NULL)
    OR ("status" <> 'SUCCEEDED' AND "credited_txn_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_provider_ref_unique"
  ON "payment_intents" ("provider", "provider_ref");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_credited_txn_unique"
  ON "payment_intents" ("credited_txn_id") WHERE "credited_txn_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payment_intents_user_idx" ON "payment_intents" ("user_id", "created_at" DESC);
--> statement-breakpoint

-- Permanent NUBAN per user — the dominant Nigerian deposit UX. One account
-- per user per provider, reused forever, so a transfer into it is
-- attributable without the user quoting a reference.
CREATE TABLE "virtual_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "provider" text NOT NULL,
  "provider_ref" text NOT NULL,
  "account_number" text NOT NULL,
  "account_name" text NOT NULL,
  "bank_name" text NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_accounts_user_provider_unique"
  ON "virtual_accounts" ("user_id", "provider");
--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_accounts_provider_ref_unique"
  ON "virtual_accounts" ("provider", "provider_ref");
--> statement-breakpoint

-- ============================================================================
-- WITHDRAWALS
-- ============================================================================

CREATE TABLE "withdrawals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "amount_minor" bigint NOT NULL,
  "bank_code" text NOT NULL,
  "account_number" text NOT NULL,
  "account_name" text NOT NULL,
  "status" "withdrawal_status" DEFAULT 'REQUESTED' NOT NULL,

  -- Funds are debited when the withdrawal is REQUESTED, not when it is paid.
  -- Holding the money up front is what stops a user staking or withdrawing
  -- the same balance twice while a payout is in flight. NOT NULL + UNIQUE
  -- makes "withdrawal recorded without a debit" unrepresentable.
  "debit_txn_id" uuid NOT NULL REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Set when a failed/rejected withdrawal returns the money.
  "refund_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  "provider" text,
  "provider_ref" text,
  "approved_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "approval_reason" text,
  "failure_reason" text,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "withdrawals_amount_positive" CHECK ("amount_minor" > 0),
  -- Terminal-but-unpaid states are exactly the ones that must have returned
  -- the money.
  CONSTRAINT "withdrawals_refund_matches_status" CHECK (
    ("status" IN ('REJECTED', 'FAILED') AND "refund_txn_id" IS NOT NULL)
    OR ("status" NOT IN ('REJECTED', 'FAILED') AND "refund_txn_id" IS NULL)
  ),
  CONSTRAINT "withdrawals_approval_recorded" CHECK (
    ("status" = 'REQUESTED' AND "approved_by" IS NULL)
    OR ("status" <> 'REQUESTED')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_debit_txn_unique" ON "withdrawals" ("debit_txn_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_refund_txn_unique"
  ON "withdrawals" ("refund_txn_id") WHERE "refund_txn_id" IS NOT NULL;
--> statement-breakpoint
-- One provider transfer reference maps to one withdrawal: the guard against
-- a retried Transfers API call paying out twice.
CREATE UNIQUE INDEX "withdrawals_provider_ref_unique"
  ON "withdrawals" ("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "withdrawals_user_idx" ON "withdrawals" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "withdrawals_pending_idx" ON "withdrawals" ("status")
  WHERE "status" IN ('REQUESTED', 'APPROVED', 'PROCESSING');
--> statement-breakpoint

-- ============================================================================
-- KYC + SELF-EXCLUSION
-- ============================================================================

-- Identity numbers are stored ONLY as HMAC-SHA256 digests under a server-held
-- pepper (see src/modules/kyc/identity.ts).
--
-- A BVN is 11 digits — 10^11 candidates — so a plain SHA-256 digest is
-- recovered by brute force in seconds and would be plaintext in all but name.
-- A per-row random salt would defeat that, but then identities could not be
-- looked up, and §7 requires self-exclusion to survive re-registration, which
-- is a lookup. HMAC under a pepper held outside the database is deterministic
-- (so it is searchable) and infeasible to reverse without the pepper.
CREATE TABLE "kyc_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "level" integer NOT NULL,
  "bvn_hash" text,
  "nin_hash" text,
  -- Object key in the private R2 bucket. Documents are never served directly;
  -- access is via short-lived signed URLs.
  "document_key" text,
  "provider" "kyc_provider" NOT NULL,
  "provider_ref" text,
  "verified_at" timestamp(6) with time zone,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "kyc_records_level_range" CHECK ("level" BETWEEN 0 AND 3),
  -- Structural defence against a raw identity number reaching this column: an
  -- 11-digit BVN cannot satisfy a 64-hex-character pattern.
  CONSTRAINT "kyc_records_bvn_is_digest" CHECK (
    "bvn_hash" IS NULL OR "bvn_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "kyc_records_nin_is_digest" CHECK (
    "nin_hash" IS NULL OR "nin_hash" ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
CREATE INDEX "kyc_records_user_idx" ON "kyc_records" ("user_id", "created_at" DESC);
--> statement-breakpoint
-- One verified identity, one account. This is how multi-accounting is caught.
CREATE UNIQUE INDEX "kyc_records_bvn_unique" ON "kyc_records" ("bvn_hash")
  WHERE "bvn_hash" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_records_nin_unique" ON "kyc_records" ("nin_hash")
  WHERE "nin_hash" IS NOT NULL;
--> statement-breakpoint

-- Keyed on the identity digest, NOT on a user id or email: a self-excluded
-- person who registers again with a new address must still be excluded.
CREATE TABLE "self_exclusions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_hash" text NOT NULL,
  -- NULL means permanent. A dated exclusion cannot be lifted early.
  "until" timestamp(6) with time zone,
  "reason" text,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "self_exclusions_identity_is_digest" CHECK (
    "identity_hash" ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
CREATE INDEX "self_exclusions_identity_idx" ON "self_exclusions" ("identity_hash");
--> statement-breakpoint

-- ============================================================================
-- STATE MACHINE
-- ============================================================================

-- REQUESTED -> APPROVED | REJECTED
-- APPROVED  -> PROCESSING
-- PROCESSING-> PAID | FAILED
-- PAID | REJECTED | FAILED -> terminal
--
-- PAID is terminal and unreachable twice, which is what stops a retried
-- provider callback paying a withdrawal out a second time (§7).
CREATE OR REPLACE FUNCTION withdrawals_guard_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'REQUESTED'  AND NEW.status IN ('APPROVED', 'REJECTED'))
      OR (OLD.status = 'APPROVED'   AND NEW.status IN ('PROCESSING', 'REJECTED'))
      OR (OLD.status = 'PROCESSING' AND NEW.status IN ('PAID', 'FAILED'))
    ) THEN
      RAISE EXCEPTION 'illegal withdrawal transition % -> % on %',
        OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.debit_txn_id IS DISTINCT FROM OLD.debit_txn_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'withdrawal % request facts are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER withdrawals_guard_transition_trigger
  BEFORE UPDATE ON "withdrawals"
  FOR EACH ROW EXECUTE FUNCTION withdrawals_guard_transition();
--> statement-breakpoint

-- A settled deposit is evidence and must not be re-pointed at another credit.
CREATE OR REPLACE FUNCTION payment_intents_guard_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'SUCCEEDED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'payment intent % already succeeded', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.credited_txn_id IS NOT NULL
     AND NEW.credited_txn_id IS DISTINCT FROM OLD.credited_txn_id THEN
    RAISE EXCEPTION 'payment intent % credit is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'payment intent % identity is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_intents_guard_transition_trigger
  BEFORE UPDATE ON "payment_intents"
  FOR EACH ROW EXECUTE FUNCTION payment_intents_guard_transition();
--> statement-breakpoint

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT USAGE ON TYPE "payment_intent_status", "withdrawal_status", "kyc_provider" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "payment_intents", "withdrawals" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "virtual_accounts", "kyc_records", "self_exclusions" TO app_role;
--> statement-breakpoint

-- Identity evidence and exclusions are append-only. A self-exclusion that the
-- application could delete is not a self-exclusion.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "kyc_records", "self_exclusions" FROM app_role;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE "payment_intents", "withdrawals", "virtual_accounts" FROM app_role;
