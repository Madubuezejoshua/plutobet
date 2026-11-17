-- Phase 14: promotions, bonuses and loyalty.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- This is where the BONUS wallet bucket from phase 4 finally gets used. The
-- segregation was built first on purpose: separating bonus credit from cash
-- after promotions are live means migrating live money, and getting it wrong
-- means paying out promotional credit as though it were the customer's.
--
-- THE RULE THE WHOLE MODULE SERVES
-- Bonus credit is NOT the customer's money until its wagering requirement is
-- met. Until then it can be staked but not withdrawn -- which the database
-- already enforces, since a withdrawal may only debit a CASH wallet.
--
-- WHY WAGERING PROGRESS IS TRACKED IN KOBO STAKED, NOT IN "TIMES"
-- "Wager it 5x" is how it is advertised, but storing a multiplier means
-- recomputing the target every time the bonus changes and re-deriving progress
-- from a moving base. Storing the absolute target in kobo, fixed when the
-- bonus is granted, means progress is a simple sum that cannot drift.

CREATE TYPE "promotion_kind" AS ENUM (
  'WELCOME_BONUS',
  'DEPOSIT_BONUS',
  'RELOAD_BONUS',
  'FREE_BET',
  'CASHBACK'
);
--> statement-breakpoint

CREATE TYPE "bonus_status" AS ENUM ('ACTIVE', 'CONVERTED', 'EXPIRED', 'FORFEITED');
--> statement-breakpoint

CREATE TABLE "promotions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text,
  "name" text NOT NULL,
  "kind" "promotion_kind" NOT NULL,
  "description" text NOT NULL,

  -- Match rate in basis points: 10000 = 100% of the deposit.
  "match_basis_points" integer,
  "max_bonus_minor" bigint,
  "min_deposit_minor" bigint DEFAULT 0 NOT NULL,
  -- Multiplier the bonus must be staked through before it converts to cash.
  "wagering_multiplier" integer DEFAULT 1 NOT NULL,
  "bonus_validity_days" integer DEFAULT 30 NOT NULL,

  "starts_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "ends_at" timestamp(6) with time zone,
  "max_claims" integer,
  "max_claims_per_user" integer DEFAULT 1 NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "promotions_code_format" CHECK (
    "code" IS NULL OR "code" ~ '^[A-Z0-9]{3,20}$'
  ),
  CONSTRAINT "promotions_match_valid" CHECK (
    "match_basis_points" IS NULL OR "match_basis_points" BETWEEN 1 AND 100000
  ),
  CONSTRAINT "promotions_max_bonus_positive" CHECK (
    "max_bonus_minor" IS NULL OR "max_bonus_minor" > 0
  ),
  CONSTRAINT "promotions_wagering_valid" CHECK ("wagering_multiplier" BETWEEN 0 AND 100),
  CONSTRAINT "promotions_validity_valid" CHECK ("bonus_validity_days" BETWEEN 1 AND 365),
  CONSTRAINT "promotions_claims_positive" CHECK (
    ("max_claims" IS NULL OR "max_claims" > 0) AND "max_claims_per_user" > 0
  ),
  CONSTRAINT "promotions_window_ordered" CHECK (
    "ends_at" IS NULL OR "ends_at" > "starts_at"
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX "promotions_code_unique" ON "promotions" ("code") WHERE "code" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "promotions_active_idx" ON "promotions" ("active", "starts_at");
--> statement-breakpoint

-- One granted bonus.
CREATE TABLE "bonuses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promotion_id" uuid NOT NULL
    REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  "granted_minor" bigint NOT NULL,
  -- Fixed at grant time, in kobo. Storing the absolute target rather than the
  -- multiplier means progress is a sum that cannot drift when the promotion is
  -- later edited.
  "wagering_required_minor" bigint NOT NULL,
  "wagered_minor" bigint DEFAULT 0 NOT NULL,

  "status" "bonus_status" DEFAULT 'ACTIVE' NOT NULL,
  -- The credit into the BONUS bucket.
  "grant_txn_id" uuid NOT NULL
    REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The BONUS -> CASH transfer, once wagering is met.
  "conversion_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  "expires_at" timestamp(6) with time zone NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp(6) with time zone,

  CONSTRAINT "bonuses_granted_positive" CHECK ("granted_minor" > 0),
  CONSTRAINT "bonuses_wagering_nonnegative" CHECK (
    "wagering_required_minor" >= 0 AND "wagered_minor" >= 0
  )
);
--> statement-breakpoint

-- One grant transaction backs exactly one bonus, so a retried claim cannot
-- produce two.
CREATE UNIQUE INDEX "bonuses_grant_txn_unique" ON "bonuses" ("grant_txn_id");
--> statement-breakpoint
CREATE INDEX "bonuses_user_idx" ON "bonuses" ("user_id", "status");
--> statement-breakpoint
CREATE INDEX "bonuses_expiry_idx" ON "bonuses" ("expires_at") WHERE "status" = 'ACTIVE';
--> statement-breakpoint

-- A granted bonus is a commitment. Its amount and its wagering requirement are
-- fixed at grant time -- raising the requirement after someone has started
-- working through it would move the goalposts on a promise already made.
CREATE OR REPLACE FUNCTION "bonuses_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."granted_minor" IS DISTINCT FROM OLD."granted_minor"
     OR NEW."wagering_required_minor" IS DISTINCT FROM OLD."wagering_required_minor"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."promotion_id" IS DISTINCT FROM OLD."promotion_id"
     OR NEW."grant_txn_id" IS DISTINCT FROM OLD."grant_txn_id" THEN
    RAISE EXCEPTION 'bonus % terms are fixed once granted', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- Wagering progress only ever increases. A decrease would mean a stake was
  -- un-counted, which is either a bug or a way to keep somebody short of the
  -- target forever.
  IF NEW."wagered_minor" < OLD."wagered_minor" THEN
    RAISE EXCEPTION 'bonus % wagering progress cannot decrease', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'ACTIVE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'bonus % is already %', OLD."id", OLD."status"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "bonuses_guard_trigger"
  BEFORE UPDATE ON "bonuses"
  FOR EACH ROW EXECUTE FUNCTION "bonuses_guard"();
--> statement-breakpoint

-- Which promotions a customer has claimed, for the per-user cap.
CREATE TABLE "promotion_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promotion_id" uuid NOT NULL
    REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "bonus_id" uuid REFERENCES "bonuses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX "promotion_claims_user_idx" ON "promotion_claims" ("user_id", "promotion_id");
--> statement-breakpoint
CREATE INDEX "promotion_claims_promotion_idx" ON "promotion_claims" ("promotion_id");
--> statement-breakpoint

-- ============================================================================
-- LOYALTY
-- ============================================================================

-- Tier is DERIVED from turnover rather than stored as a status somebody can
-- set: a loyalty level that can be assigned by hand stops meaning anything.
-- Points accumulate from real staking and are the only input.
CREATE TABLE "loyalty_accounts" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "points" bigint DEFAULT 0 NOT NULL,
  "lifetime_points" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "loyalty_points_nonnegative" CHECK ("points" >= 0 AND "lifetime_points" >= 0),
  -- Spending points reduces the balance but never the lifetime total, so a
  -- customer cannot be demoted by redeeming a reward they earned.
  CONSTRAINT "loyalty_lifetime_at_least_balance" CHECK ("lifetime_points" >= "points")
);
--> statement-breakpoint

GRANT USAGE ON TYPE "promotion_kind", "bonus_status" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "promotions", "bonuses", "promotion_claims", "loyalty_accounts" TO app_role;
