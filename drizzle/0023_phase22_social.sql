-- Phase 22: social features.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- THE PRIVACY RULE, WHICH SHAPES EVERY TABLE HERE
-- Spec 22.1: never publicly expose wallet balance, deposits, withdrawals, KYC,
-- or private account data.
--
-- That is enforced structurally rather than by remembering to omit columns.
-- Nothing below references a wallet, a balance, a stake or a payout. A shared
-- slip carries SELECTIONS and nothing else, so there is no query anybody can
-- write against these tables that reveals what a person staked or holds.
--
-- WHY A SHARED SLIP IS A BOOKING CODE
-- Phase 7 already built a shareable slip that stores selections and cannot
-- store a price or a stake. Sharing socially is the same object with an
-- audience, so it reuses it rather than inventing a second sharing mechanism
-- that would need the same restrictions applied again -- and might not get them.

CREATE TABLE "public_profiles" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The display name others see. Separate from the account username so a
  -- customer can change what is public without changing what they log in with.
  "handle" text NOT NULL,
  "bio" text,
  -- Off by default. A social feature nobody opted into is a social feature that
  -- exposed somebody who did not want to be exposed.
  "visible" boolean DEFAULT false NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "public_profiles_handle_format" CHECK ("handle" ~ '^[a-z0-9_]{3,20}$'),
  CONSTRAINT "public_profiles_bio_length" CHECK ("bio" IS NULL OR char_length("bio") <= 200)
);
--> statement-breakpoint

CREATE UNIQUE INDEX "public_profiles_handle_unique" ON "public_profiles" ("handle");
--> statement-breakpoint

CREATE TABLE "follows" (
  "follower_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "followee_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("follower_id", "followee_id"),

  CONSTRAINT "follows_not_self" CHECK ("follower_id" <> "followee_id")
);
--> statement-breakpoint

CREATE INDEX "follows_followee_idx" ON "follows" ("followee_id");
--> statement-breakpoint

-- A shared slip.
--
-- Note what is NOT here: no stake, no potential return, no bet id, no wallet
-- reference. It points at a booking code, which by its own design can hold only
-- selections. Somebody sharing a slip is sharing their opinion, not their
-- finances.
CREATE TABLE "shared_slips" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "booking_code_id" uuid NOT NULL
    REFERENCES "booking_codes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "caption" text,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "shared_slips_caption_length" CHECK (
    "caption" IS NULL OR char_length("caption") <= 280
  )
);
--> statement-breakpoint

CREATE INDEX "shared_slips_user_idx" ON "shared_slips" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "shared_slips_recent_idx" ON "shared_slips" ("created_at" DESC);
--> statement-breakpoint

CREATE TABLE "slip_reactions" (
  "shared_slip_id" uuid NOT NULL
    REFERENCES "shared_slips"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("shared_slip_id", "user_id")
);
--> statement-breakpoint

-- ============================================================================
-- MODERATION
-- ============================================================================

CREATE TYPE "report_status" AS ENUM ('OPEN', 'UPHELD', 'DISMISSED');
--> statement-breakpoint

CREATE TABLE "content_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reporter_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "shared_slip_id" uuid REFERENCES "shared_slips"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  "reported_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "reason" text NOT NULL,
  "status" "report_status" DEFAULT 'OPEN' NOT NULL,
  "moderator_id" uuid REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  "moderator_note" text,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp(6) with time zone,

  CONSTRAINT "content_reports_reason_meaningful" CHECK (
    char_length(btrim("reason")) BETWEEN 3 AND 500
  ),
  -- A report must be about something.
  CONSTRAINT "content_reports_has_subject" CHECK (
    "shared_slip_id" IS NOT NULL OR "reported_user_id" IS NOT NULL
  ),
  -- A decision needs a note. A moderation action nobody explained cannot be
  -- reviewed later, which is exactly when somebody appeals it.
  CONSTRAINT "content_reports_decision_explained" CHECK (
    "status" = 'OPEN' OR "moderator_note" IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX "content_reports_queue_idx" ON "content_reports" ("status", "created_at")
  WHERE "status" = 'OPEN';
--> statement-breakpoint
-- One person reports one thing once; repeat reports are noise, not signal.
CREATE UNIQUE INDEX "content_reports_reporter_slip_unique"
  ON "content_reports" ("reporter_id", "shared_slip_id")
  WHERE "shared_slip_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "user_blocks" (
  "blocker_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "blocked_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("blocker_id", "blocked_id"),

  CONSTRAINT "user_blocks_not_self" CHECK ("blocker_id" <> "blocked_id")
);
--> statement-breakpoint

-- A moderation decision is a record. Reversing one is a new decision, so the
-- original stays visible rather than being overwritten.
CREATE OR REPLACE FUNCTION "content_reports_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'OPEN' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'report % has already been decided', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  IF NEW."reporter_id" IS DISTINCT FROM OLD."reporter_id"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" THEN
    RAISE EXCEPTION 'report % is immutable', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "content_reports_guard_trigger"
  BEFORE UPDATE ON "content_reports"
  FOR EACH ROW EXECUTE FUNCTION "content_reports_guard"();
--> statement-breakpoint

GRANT USAGE ON TYPE "report_status" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  "public_profiles", "follows", "shared_slips", "slip_reactions", "content_reports", "user_blocks"
  TO app_role;
--> statement-breakpoint
-- Unfollowing, un-reacting and unblocking are genuine deletes.
GRANT DELETE ON TABLE "follows", "slip_reactions", "user_blocks" TO app_role;
