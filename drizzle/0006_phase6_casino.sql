-- Phase 6: casino aggregator integration.
--
-- No game logic and no RNG live here by design: self-built RNG does not pass
-- GLI-33, so outcomes come from a certified aggregator and this module only
-- moves money and keeps evidence.
--
-- Run only through the unpooled owner/migration connection.

CREATE TYPE "game_round_status" AS ENUM ('OPEN', 'SETTLED', 'ROLLED_BACK');
--> statement-breakpoint

-- Short-lived handoff token. The aggregator launches a game with it and then
-- calls back quoting it, which is how their request is tied to our user
-- without exposing a session cookie to a third party.
CREATE TABLE "casino_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "provider" text NOT NULL,
  -- Stored as a digest, never the raw token: this table is a credential
  -- store, and a leaked row must not be replayable as a live session.
  "token_hash" text NOT NULL,
  "game" text,
  "expires_at" timestamp(6) with time zone NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "casino_sessions_token_is_digest" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "casino_sessions_token_unique" ON "casino_sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX "casino_sessions_user_idx" ON "casino_sessions" ("user_id", "created_at" DESC);
--> statement-breakpoint

-- One row per round the aggregator reports.
--
-- A round is not a single money movement: it has a stake debit, usually a
-- win credit, and sometimes a rollback. Each of those is idempotent on its
-- OWN key — see the unique indexes below — because keying only on the round
-- reference would make a win dedupe against its own stake.
CREATE TABLE "game_rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "provider" text NOT NULL,
  "provider_round_ref" text NOT NULL,
  "game" text NOT NULL,

  "stake_minor" bigint DEFAULT 0 NOT NULL,
  "payout_minor" bigint DEFAULT 0 NOT NULL,
  "status" "game_round_status" DEFAULT 'OPEN' NOT NULL,

  "debit_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  "credit_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  "rollback_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Verbatim, for dispute resolution against the aggregator.
  "raw_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "game_rounds_stake_nonnegative" CHECK ("stake_minor" >= 0),
  CONSTRAINT "game_rounds_payout_nonnegative" CHECK ("payout_minor" >= 0),
  -- A rolled-back round returned its stake, and nothing else may have.
  CONSTRAINT "game_rounds_rollback_matches_status" CHECK (
    ("status" = 'ROLLED_BACK' AND "rollback_txn_id" IS NOT NULL)
    OR ("status" <> 'ROLLED_BACK' AND "rollback_txn_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "game_rounds_provider_ref_unique"
  ON "game_rounds" ("provider", "provider_round_ref");
--> statement-breakpoint
-- One ledger transaction per money leg per round. These are the constraints
-- that make a replayed aggregator callback structurally unable to pay twice.
CREATE UNIQUE INDEX "game_rounds_debit_txn_unique"
  ON "game_rounds" ("debit_txn_id") WHERE "debit_txn_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "game_rounds_credit_txn_unique"
  ON "game_rounds" ("credit_txn_id") WHERE "credit_txn_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "game_rounds_rollback_txn_unique"
  ON "game_rounds" ("rollback_txn_id") WHERE "rollback_txn_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "game_rounds_user_idx" ON "game_rounds" ("user_id", "created_at" DESC);
--> statement-breakpoint

-- OPEN -> SETTLED | ROLLED_BACK, and nothing leaves a terminal state.
CREATE OR REPLACE FUNCTION game_rounds_guard_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'OPEN' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'game round % is already %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.provider_round_ref IS DISTINCT FROM OLD.provider_round_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'game round % identity is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Each money leg is written once. Re-pointing one at a different ledger
  -- transaction would be a second payout wearing the first one's clothes.
  IF (OLD.debit_txn_id IS NOT NULL AND NEW.debit_txn_id IS DISTINCT FROM OLD.debit_txn_id)
     OR (OLD.credit_txn_id IS NOT NULL AND NEW.credit_txn_id IS DISTINCT FROM OLD.credit_txn_id)
     OR (OLD.rollback_txn_id IS NOT NULL AND NEW.rollback_txn_id IS DISTINCT FROM OLD.rollback_txn_id)
  THEN
    RAISE EXCEPTION 'game round % money legs are immutable once written', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER game_rounds_guard_transition_trigger
  BEFORE UPDATE ON "game_rounds"
  FOR EACH ROW EXECUTE FUNCTION game_rounds_guard_transition();
--> statement-breakpoint

GRANT USAGE ON TYPE "game_round_status" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "game_rounds" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "casino_sessions" TO app_role;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE "game_rounds", "casino_sessions" FROM app_role;
