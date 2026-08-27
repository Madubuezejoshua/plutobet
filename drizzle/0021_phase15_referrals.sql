-- Phase 15: referrals and affiliates.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- `users.referral_code` and `users.referred_by` already exist from phase 2, and
-- the database already refuses a self-referral. What was missing is everything
-- that decides whether a referral is WORTH anything.
--
-- THE RULE THAT SHAPES THIS
-- A referral pays on QUALIFICATION, never on signup.
--
-- Paying for a registration is paying for an email address, and the going rate
-- for ten thousand of those is lower than any bonus worth offering. Requiring a
-- real deposit and real turnover before anything is owed means the reward is
-- funded by activity that actually happened. Every referral scheme that pays on
-- signup gets farmed within a week.
--
-- THE ABUSE THIS CANNOT FULLY STOP, AND SAYS SO
-- One person with two phones is a referral pair we cannot distinguish from two
-- friends. The identity check below catches the same VERIFIED person twice,
-- which is the version that matters for money, but a determined farmer with two
-- real identities is a risk-team problem rather than a constraint problem.

CREATE TYPE "referral_status" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'REJECTED');
--> statement-breakpoint

CREATE TABLE "referrals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "referrer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "referred_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  "status" "referral_status" DEFAULT 'PENDING' NOT NULL,

  -- What the referred account has actually done. Both must clear the
  -- thresholds before anything is owed.
  "deposited_minor" bigint DEFAULT 0 NOT NULL,
  "wagered_minor" bigint DEFAULT 0 NOT NULL,

  "qualified_at" timestamp(6) with time zone,
  "reward_minor" bigint,
  "reward_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  "rejected_reason" text,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "referrals_not_self" CHECK ("referrer_id" <> "referred_id"),
  CONSTRAINT "referrals_progress_nonnegative" CHECK (
    "deposited_minor" >= 0 AND "wagered_minor" >= 0
  ),
  CONSTRAINT "referrals_reward_nonnegative" CHECK (
    "reward_minor" IS NULL OR "reward_minor" >= 0
  )
);
--> statement-breakpoint

-- An account can be referred ONCE, by one person, ever. Without this, a second
-- referrer could claim a customer who was already introduced.
CREATE UNIQUE INDEX "referrals_referred_unique" ON "referrals" ("referred_id");
--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" ("referrer_id", "status");
--> statement-breakpoint
-- One payment per referral.
CREATE UNIQUE INDEX "referrals_reward_txn_unique" ON "referrals" ("reward_txn_id")
  WHERE "reward_txn_id" IS NOT NULL;
--> statement-breakpoint

-- Progress only ever increases, and a paid referral cannot be re-paid.
CREATE OR REPLACE FUNCTION "referrals_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."referrer_id" IS DISTINCT FROM OLD."referrer_id"
     OR NEW."referred_id" IS DISTINCT FROM OLD."referred_id" THEN
    RAISE EXCEPTION 'referral % parties are immutable', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."deposited_minor" < OLD."deposited_minor"
     OR NEW."wagered_minor" < OLD."wagered_minor" THEN
    RAISE EXCEPTION 'referral % progress cannot decrease', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'REWARDED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'referral % has already been paid', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "referrals_guard_trigger"
  BEFORE UPDATE ON "referrals"
  FOR EACH ROW EXECUTE FUNCTION "referrals_guard"();
--> statement-breakpoint

-- ============================================================================
-- AFFILIATES
-- ============================================================================

-- A commercial partner sending traffic, as distinct from a customer inviting a
-- friend. Separate tables because the economics differ: an affiliate earns a
-- revenue share over the customer's lifetime, a referrer earns a one-off.
CREATE TABLE "affiliates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "name" text NOT NULL,
  "code" text NOT NULL,

  -- Share of net revenue from their referred customers, in basis points.
  "commission_basis_points" integer DEFAULT 2500 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "affiliates_code_format" CHECK ("code" ~ '^[A-Z0-9]{3,20}$'),
  CONSTRAINT "affiliates_commission_valid" CHECK (
    "commission_basis_points" BETWEEN 0 AND 10000
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX "affiliates_code_unique" ON "affiliates" ("code");
--> statement-breakpoint

-- Click counts, bucketed by day rather than one row per click. A row per click
-- is a table that grows faster than the betting tables and is never read at
-- that resolution.
CREATE TABLE "affiliate_clicks" (
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "day" date NOT NULL,
  "clicks" integer DEFAULT 0 NOT NULL,
  PRIMARY KEY ("affiliate_id", "day"),

  CONSTRAINT "affiliate_clicks_nonnegative" CHECK ("clicks" >= 0)
);
--> statement-breakpoint

CREATE TABLE "affiliate_conversions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "qualified_at" timestamp(6) with time zone,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- A customer belongs to one affiliate. Two partners claiming the same signup is
-- how commission gets paid twice on one person.
CREATE UNIQUE INDEX "affiliate_conversions_user_unique" ON "affiliate_conversions" ("user_id");
--> statement-breakpoint
CREATE INDEX "affiliate_conversions_affiliate_idx"
  ON "affiliate_conversions" ("affiliate_id", "created_at" DESC);
--> statement-breakpoint

-- Commission accrued per affiliate per month, computed from net revenue.
CREATE TABLE "affiliate_commissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,

  "net_revenue_minor" bigint NOT NULL,
  "commission_minor" bigint NOT NULL,
  "paid_txn_id" uuid REFERENCES "ledger_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "affiliate_commissions_period_ordered" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "affiliate_commissions_amounts_valid" CHECK ("commission_minor" >= 0)
);
--> statement-breakpoint

-- One statement per affiliate per period; a second would double-count.
CREATE UNIQUE INDEX "affiliate_commissions_period_unique"
  ON "affiliate_commissions" ("affiliate_id", "period_start");
--> statement-breakpoint

GRANT USAGE ON TYPE "referral_status" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  "referrals", "affiliates", "affiliate_clicks", "affiliate_conversions", "affiliate_commissions"
  TO app_role;
