-- Phase 2: user account model, preferences, and device sessions.
--
-- Three things this migration exists to fix, in order of seriousness:
--
--  1. THERE WAS NO DATE OF BIRTH. The platform had no way to know whether an
--     account holder is old enough to gamble. That is a licence condition, not
--     a feature, and it is cheapest to add before real accounts exist.
--
--  2. The status vocabulary had three values where the product needs six.
--     "Restricted" and "verification required" were being approximated by
--     suspension, which is a blunter instrument than intended and is not
--     reversible in the same way.
--
--  3. Profile, preferences and device sessions had nowhere to live.

-- ============================================================================
-- ENUMS
-- ============================================================================

-- ADD VALUE is safe alongside the rest of this file because nothing here
-- *evaluates* a new value: the transition trigger below compares ::text, so
-- the literals are never resolved against the enum at function-creation time.
ALTER TYPE "user_status" ADD VALUE IF NOT EXISTS 'RESTRICTED';
--> statement-breakpoint
ALTER TYPE "user_status" ADD VALUE IF NOT EXISTS 'VERIFICATION_REQUIRED';
--> statement-breakpoint
ALTER TYPE "user_status" ADD VALUE IF NOT EXISTS 'CLOSED';
--> statement-breakpoint

-- Risk standing is deliberately separate from account status. An account can
-- be perfectly active and still be worth watching; collapsing the two would
-- mean every risk flag visibly punished the customer.
CREATE TYPE "user_risk_status" AS ENUM ('NORMAL', 'WATCH', 'HIGH');
--> statement-breakpoint

CREATE TYPE "odds_format" AS ENUM ('DECIMAL', 'FRACTIONAL', 'AMERICAN');
--> statement-breakpoint

-- ============================================================================
-- USERS
-- ============================================================================

ALTER TABLE "users" ADD COLUMN "first_name" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_name" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;
--> statement-breakpoint

-- Nullable because accounts already exist without one. New registrations are
-- required to supply it at the service boundary; the trigger below enforces
-- the age rule whenever a value IS present, so a null can never sneak an
-- underage account past the check — it can only produce an account that has
-- not proven its age yet.
ALTER TABLE "users" ADD COLUMN "date_of_birth" date;
--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "country" text DEFAULT 'NG' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "risk_status" "user_risk_status" DEFAULT 'NORMAL' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_code" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referred_by" uuid REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp(6) with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_verified_at" timestamp(6) with time zone;
--> statement-breakpoint

-- Usernames are stored already-lowercased so that uniqueness is genuinely
-- case-insensitive without needing citext. "Joshua" and "joshua" must not be
-- two different people on a platform where a username identifies a punter.
ALTER TABLE "users" ADD CONSTRAINT "users_username_canonical" CHECK (
  "username" IS NULL OR (
    "username" = lower("username")
    AND "username" ~ '^[a-z0-9_]{3,20}$'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" ("username") WHERE "username" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_referral_code_format" CHECK (
  "referral_code" IS NULL OR "referral_code" ~ '^[A-Z0-9]{6,12}$'
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_referral_code_unique" ON "users" ("referral_code")
  WHERE "referral_code" IS NOT NULL;
--> statement-breakpoint

-- Nobody may refer themselves. This is the cheapest referral abuse there is.
ALTER TABLE "users" ADD CONSTRAINT "users_no_self_referral" CHECK (
  "referred_by" IS NULL OR "referred_by" <> "id"
);
--> statement-breakpoint

-- A birth date in the future, or implying an implausible age, is corrupt data
-- rather than an old customer. Both bounds are constants, so this is
-- immutable and legal in a CHECK; the 18-year rule is NOT immutable (it moves
-- with the clock) and therefore lives in the trigger below.
ALTER TABLE "users" ADD CONSTRAINT "users_dob_plausible" CHECK (
  "date_of_birth" IS NULL
  OR ("date_of_birth" > DATE '1900-01-01' AND "date_of_birth" < DATE '2100-01-01')
);
--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_country_format" CHECK ("country" ~ '^[A-Z]{2}$');
--> statement-breakpoint

-- ============================================================================
-- AGE GATE
-- ============================================================================

-- The legal minimum, enforced in the database rather than only in the service.
-- An application bug, a bad migration or a manual UPDATE must not be able to
-- create an underage account: this is the control a regulator will ask about.
CREATE OR REPLACE FUNCTION "enforce_minimum_age"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."date_of_birth" IS NOT NULL
     AND NEW."date_of_birth" > (CURRENT_DATE - INTERVAL '18 years') THEN
    RAISE EXCEPTION 'account holder must be at least 18 years old'
      USING ERRCODE = '23514',
            CONSTRAINT = 'users_minimum_age';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "users_minimum_age"
  BEFORE INSERT OR UPDATE OF "date_of_birth" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "enforce_minimum_age"();
--> statement-breakpoint

-- ============================================================================
-- STATUS TRANSITIONS
-- ============================================================================

-- Replaces the three-state machine from 0000.
--
--   ACTIVE                -> SUSPENDED | RESTRICTED | VERIFICATION_REQUIRED
--                            | SELF_EXCLUDED | CLOSED
--   SUSPENDED             -> ACTIVE | RESTRICTED | SELF_EXCLUDED | CLOSED
--   RESTRICTED            -> ACTIVE | SUSPENDED | SELF_EXCLUDED | CLOSED
--   VERIFICATION_REQUIRED -> ACTIVE | SUSPENDED | SELF_EXCLUDED | CLOSED
--   SELF_EXCLUDED         -> terminal
--   CLOSED                -> terminal
--
-- SELF_EXCLUDED stays terminal, as it was: an ordinary status update must
-- never be able to reinstate someone who excluded themselves. Reinstatement
-- after an exclusion period is a separate regulated workflow with its own
-- checks, not an UPDATE.
--
-- CLOSED is terminal too. Reopening is a new account, which is the only way
-- the exclusion and KYC checks get re-run.
--
-- Comparisons are on ::text so this function body never resolves an enum
-- literal, which is what lets it coexist with ALTER TYPE ADD VALUE above.
CREATE OR REPLACE FUNCTION "enforce_user_status_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       (OLD."status"::text = 'ACTIVE'
         AND NEW."status"::text IN ('SUSPENDED', 'RESTRICTED', 'VERIFICATION_REQUIRED',
                                    'SELF_EXCLUDED', 'CLOSED'))
       OR (OLD."status"::text = 'SUSPENDED'
         AND NEW."status"::text IN ('ACTIVE', 'RESTRICTED', 'SELF_EXCLUDED', 'CLOSED'))
       OR (OLD."status"::text = 'RESTRICTED'
         AND NEW."status"::text IN ('ACTIVE', 'SUSPENDED', 'SELF_EXCLUDED', 'CLOSED'))
       OR (OLD."status"::text = 'VERIFICATION_REQUIRED'
         AND NEW."status"::text IN ('ACTIVE', 'SUSPENDED', 'SELF_EXCLUDED', 'CLOSED'))
     ) THEN
    RAISE EXCEPTION 'illegal user status transition from % to %', OLD."status", NEW."status"
      USING ERRCODE = '23514',
            CONSTRAINT = 'users_status_transition_valid';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ============================================================================
-- PREFERENCES
-- ============================================================================

-- One row per user, created lazily. Kept out of `users` because these change
-- often and for reasons that have nothing to do with identity or money — a
-- toggle on a settings screen should not write to the row that authorisation
-- reads on every request.
CREATE TABLE "user_preferences" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "odds_format" "odds_format" DEFAULT 'DECIMAL' NOT NULL,
  "email_notifications" boolean DEFAULT true NOT NULL,
  "sms_notifications" boolean DEFAULT true NOT NULL,
  "push_notifications" boolean DEFAULT false NOT NULL,
  -- Marketing is opt-IN and defaults to false, unlike service messages above.
  "marketing_emails" boolean DEFAULT false NOT NULL,
  "timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ============================================================================
-- DEVICE SESSIONS
-- ============================================================================

-- Sessions are JWTs, which are stateless and cannot be "deleted". This table
-- is what makes them revocable anyway: each token carries a session id, this
-- row is the record of it, and the auth callback refuses any token whose row
-- is missing or revoked. That turns "sign out my other device" from a lie
-- into an actual capability.
--
-- No token material is stored — only the id embedded in the claim.
CREATE TABLE "user_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "user_agent" text,
  "ip" inet,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp(6) with time zone,
  "revoked_reason" text
);
--> statement-breakpoint

CREATE INDEX "user_sessions_user_idx" ON "user_sessions" ("user_id", "last_seen_at" DESC);
--> statement-breakpoint
-- Partial index: the hot lookup on every authenticated request is "is this
-- session still live", and live sessions are the small minority over time.
CREATE INDEX "user_sessions_active_idx" ON "user_sessions" ("id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- A revocation is a fact. Un-revoking would let a stolen session be silently
-- restored, so the column only ever goes from NULL to a timestamp.
CREATE OR REPLACE FUNCTION "user_sessions_guard_revocation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'session % revocation is final', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    RAISE EXCEPTION 'session % owner is immutable', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "user_sessions_guard_revocation_trigger"
  BEFORE UPDATE ON "user_sessions"
  FOR EACH ROW EXECUTE FUNCTION "user_sessions_guard_revocation"();
--> statement-breakpoint

-- ============================================================================
-- BACKFILL
-- ============================================================================

-- Existing accounts predate referral codes. Derived from the row id so the
-- result is deterministic and needs no retry loop.
--
-- md5() rather than digest(): digest() lives in pgcrypto, and a reference to a
-- missing function fails when the statement is PARSED, so guarding it with
-- "only if the extension exists" does not help — the statement never gets as
-- far as evaluating the guard. md5() is in core and always present.
--
-- Twelve hex characters is 48 bits, which makes a collision across any
-- realistic number of legacy accounts vanishingly unlikely; the unique index
-- would catch one loudly rather than silently duplicating a code.
UPDATE "users"
SET "referral_code" = upper(substr(md5("id"::text), 1, 12))
WHERE "referral_code" IS NULL;
--> statement-breakpoint

-- Phone numbers collected before this migration went through OTP verification
-- at registration, so they are genuinely verified — but there was no column to
-- record it. Backdating to the account's creation is the honest reading.
UPDATE "users" SET "phone_verified_at" = "created_at" WHERE "phone_number" IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT USAGE ON TYPE "user_risk_status", "odds_format" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "user_preferences" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "user_sessions" TO app_role;
--> statement-breakpoint

-- Sessions and preferences are never deleted by the application: a revoked
-- session is evidence in an account-takeover investigation.
REVOKE DELETE ON TABLE "user_sessions", "user_preferences" FROM app_role;
