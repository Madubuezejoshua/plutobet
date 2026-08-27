-- Phase 3: role-based access control for the admin platform.
--
-- WHY THIS EXISTS
-- Until now `users.role` had exactly two values, so a support agent and a
-- super admin were the same principal. The master build prompt lists that
-- under prohibited shortcuts by name, and it is the kind of thing a regulator
-- asks about directly: who could have approved this withdrawal?
--
-- WHY `users.role` SURVIVES UNCHANGED
-- It stays as the coarse "may this person reach the admin area at all" flag,
-- because it is baked into the session token and re-read on every request.
-- Fine-grained authority lives in the grant table below instead. Two separate
-- questions, deliberately not collapsed:
--
--   users.role = 'ADMIN'   -> may open the admin area
--   admin_role_grants      -> what they may do once inside
--
-- A grant without ADMIN gets nowhere; ADMIN without grants can see the door
-- and nothing behind it. Both must be true.

CREATE TYPE "admin_role" AS ENUM (
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'SPORTSBOOK_MANAGER',
  'CASINO_MANAGER',
  'COMPLIANCE_OFFICER',
  'RISK_OFFICER',
  'SUPPORT_AGENT',
  'MARKETING_MANAGER'
);
--> statement-breakpoint

-- One row per (person, role). Revocation is a timestamp rather than a DELETE:
-- "who could do what, on the day it happened" is a question that gets asked
-- months later, and a deleted row cannot answer it.
CREATE TABLE "admin_role_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "role" "admin_role" NOT NULL,

  -- Who granted it. NOT NULL: a privilege nobody is accountable for is the
  -- one that turns up in an incident report with no explanation.
  "granted_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "granted_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "granted_reason" text NOT NULL,

  "revoked_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "revoked_at" timestamp(6) with time zone,
  "revoked_reason" text,

  CONSTRAINT "admin_role_grants_reason_meaningful" CHECK (
    char_length(btrim("granted_reason")) BETWEEN 3 AND 500
  ),
  CONSTRAINT "admin_role_grants_revocation_paired" CHECK (
    ("revoked_at" IS NULL) = ("revoked_by" IS NULL)
  )
);
--> statement-breakpoint

-- The hot path: "what may this person do", evaluated on every admin request.
CREATE INDEX "admin_role_grants_active_idx" ON "admin_role_grants" ("user_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- One live grant of a given role per person. Without this, granting twice and
-- revoking once would leave the privilege quietly in place.
CREATE UNIQUE INDEX "admin_role_grants_unique_active" ON "admin_role_grants" ("user_id", "role")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

CREATE INDEX "admin_role_grants_audit_idx" ON "admin_role_grants" ("granted_at" DESC);
--> statement-breakpoint

-- A grant is evidence. Its subject, its role, who issued it and why are all
-- fixed at creation, and a revocation cannot be undone — re-granting creates a
-- new row, which is exactly the history we want to keep.
CREATE OR REPLACE FUNCTION "admin_role_grants_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."granted_by" IS DISTINCT FROM OLD."granted_by"
     OR NEW."granted_at" IS DISTINCT FROM OLD."granted_at"
     OR NEW."granted_reason" IS DISTINCT FROM OLD."granted_reason" THEN
    RAISE EXCEPTION 'admin role grant % is immutable once issued', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'admin role grant % revocation is final', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "admin_role_grants_guard_trigger"
  BEFORE UPDATE ON "admin_role_grants"
  FOR EACH ROW EXECUTE FUNCTION "admin_role_grants_guard"();
--> statement-breakpoint

-- ============================================================================
-- BOOTSTRAP
-- ============================================================================

-- Existing administrators become SUPER_ADMIN, self-granted.
--
-- Without this the migration locks everybody out: RBAC would be live with
-- nobody holding any role, and the only way to grant the first one is to
-- already hold SUPER_ADMIN. The grant is recorded honestly — granted_by is the
-- account itself, and the reason says where it came from — rather than being
-- back-dated to look like a decision somebody made.
INSERT INTO "admin_role_grants" ("user_id", "role", "granted_by", "granted_reason")
SELECT "id", 'SUPER_ADMIN', "id", 'bootstrap: existing administrator at RBAC migration'
FROM "users"
WHERE "role" = 'ADMIN'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT USAGE ON TYPE "admin_role" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "admin_role_grants" TO app_role;
--> statement-breakpoint
REVOKE DELETE ON TABLE "admin_role_grants" FROM app_role;
