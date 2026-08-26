-- Phase 7: responsible gambling controls.
--
-- These are a licensing requirement, not a feature. Run only through the
-- unpooled owner/migration connection.

CREATE TYPE "rg_limit_type" AS ENUM ('DEPOSIT', 'LOSS', 'WAGER', 'SESSION');
--> statement-breakpoint

-- Append-only limit history, NOT a mutable current-value row.
--
-- Two reasons it has to be history. A regulator asks "what limit was in force
-- when this bet was placed?", which a row that gets UPDATEd cannot answer.
-- And an increase must not take effect immediately (see below), which needs a
-- future-dated row to sit alongside the one currently in force.
CREATE TABLE "rg_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "type" "rg_limit_type" NOT NULL,

  -- Rolling window the limit applies over. 1 = daily, 7 = weekly, 30 = monthly.
  "period_days" integer NOT NULL,

  -- Kobo for DEPOSIT/LOSS/WAGER; MINUTES for SESSION. One column because the
  -- alternative is a nullable pair that lets a row mean neither.
  "amount_minor" bigint NOT NULL,

  -- THE RULE THAT MAKES THIS A PROTECTION RATHER THAN A SETTING:
  -- a decrease is effective immediately, an increase only after a cooling-off
  -- delay. A player mid-session who can raise their own ceiling on the spot
  -- has no limit at all, and every serious regulator treats instant increases
  -- as non-compliant.
  "effective_from" timestamp(6) with time zone NOT NULL DEFAULT now(),

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "rg_limits_amount_nonnegative" CHECK ("amount_minor" >= 0),
  CONSTRAINT "rg_limits_period_positive" CHECK ("period_days" > 0)
);
--> statement-breakpoint
CREATE INDEX "rg_limits_active_idx"
  ON "rg_limits" ("user_id", "type", "effective_from" DESC);
--> statement-breakpoint

-- Cooling-off: a time-boxed break that is NOT self-exclusion. Kept on the
-- user because it is an account-level pause the person chose, and unlike
-- self-exclusion it expires on its own.
ALTER TABLE "users" ADD COLUMN "cool_off_until" timestamp(6) with time zone;
--> statement-breakpoint

GRANT USAGE ON TYPE "rg_limit_type" TO app_role;
--> statement-breakpoint

-- Append-only: a limit the application could delete or rewrite is not a
-- limit. Changes are new rows, which is also the audit trail.
GRANT SELECT, INSERT ON TABLE "rg_limits" TO app_role;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "rg_limits" FROM app_role;
--> statement-breakpoint
GRANT UPDATE ("cool_off_until") ON TABLE "users" TO app_role;
