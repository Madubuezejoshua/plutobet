-- Phase 21: support tickets and disputes.
--
-- (SQL comments stay within WIN1252 -- see the note in 0013.)
--
-- WHY A DISPUTE IS NOT JUST A TICKET WITH A LABEL
-- A dispute is about a specific bet, withdrawal or transaction, and it has a
-- regulatory shape a general enquiry does not: it must be answerable months
-- later, the thing being disputed must be identifiable, and the outcome must be
-- recorded. So the reference to what is disputed is a column, not something a
-- customer typed into a message body that nobody can query.
--
-- WHAT AN AGENT CANNOT DO HERE
-- Nothing in this schema moves money or changes a bet. A ticket records a
-- conversation and a decision; acting on that decision goes through the
-- ordinary money paths, with their own permissions and audit. An agent who
-- could settle a dispute by editing a row would be a support desk with a
-- payout button.

CREATE TYPE "ticket_status" AS ENUM ('OPEN', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');
--> statement-breakpoint

CREATE TYPE "ticket_category" AS ENUM (
  'ACCOUNT',
  'DEPOSIT',
  'WITHDRAWAL',
  'BET_DISPUTE',
  'VERIFICATION',
  'RESPONSIBLE_GAMBLING',
  'OTHER'
);
--> statement-breakpoint

CREATE TABLE "support_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "category" "ticket_category" NOT NULL,
  "subject" text NOT NULL,
  "status" "ticket_status" DEFAULT 'OPEN' NOT NULL,

  -- What is being disputed, when anything is. A bet id or a withdrawal id,
  -- kept as a column so a dispute can be joined to its subject rather than
  -- read out of prose.
  "disputed_entity" text,
  "disputed_entity_id" uuid,

  "assigned_to" uuid REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  "resolution" text,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp(6) with time zone,

  CONSTRAINT "support_tickets_subject_meaningful" CHECK (
    char_length(btrim("subject")) BETWEEN 3 AND 200
  ),
  CONSTRAINT "support_tickets_disputed_entity_valid" CHECK (
    "disputed_entity" IS NULL
    OR "disputed_entity" IN ('bet', 'withdrawal', 'payment_intent', 'game_round')
  ),
  -- Both halves of the reference, or neither. A dangling id nobody can resolve
  -- is worse than no reference at all.
  CONSTRAINT "support_tickets_dispute_paired" CHECK (
    ("disputed_entity" IS NULL) = ("disputed_entity_id" IS NULL)
  ),
  CONSTRAINT "support_tickets_resolution_present" CHECK (
    "status" NOT IN ('RESOLVED', 'CLOSED') OR "resolution" IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX "support_tickets_user_idx" ON "support_tickets" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "support_tickets_queue_idx" ON "support_tickets" ("status", "created_at")
  WHERE "status" IN ('OPEN', 'WAITING_CUSTOMER');
--> statement-breakpoint
CREATE INDEX "support_tickets_disputed_idx"
  ON "support_tickets" ("disputed_entity", "disputed_entity_id")
  WHERE "disputed_entity_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "support_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ticket_id" uuid NOT NULL
    REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- NULL means the platform: an automated note, or an AI summary handed over
  -- at escalation.
  "author_id" uuid REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  "from_staff" boolean DEFAULT false NOT NULL,
  "body" text NOT NULL,
  -- Notes staff write to each other. Never shown to the customer.
  "internal" boolean DEFAULT false NOT NULL,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "support_messages_body_meaningful" CHECK (
    char_length(btrim("body")) BETWEEN 1 AND 5000
  )
);
--> statement-breakpoint

CREATE INDEX "support_messages_ticket_idx" ON "support_messages" ("ticket_id", "created_at");
--> statement-breakpoint

-- A message is a record of what was said. Editing one after the fact would let
-- a disputed conversation be rewritten by either side.
CREATE OR REPLACE FUNCTION "support_messages_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'support message % cannot be edited or deleted', OLD."id"
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "support_messages_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION "support_messages_immutable"();
--> statement-breakpoint

-- The ticket's subject and what it disputes are fixed at creation. Allowing
-- either to change would let a resolved complaint be re-pointed at a different
-- bet.
CREATE OR REPLACE FUNCTION "support_tickets_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."disputed_entity" IS DISTINCT FROM OLD."disputed_entity"
     OR NEW."disputed_entity_id" IS DISTINCT FROM OLD."disputed_entity_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'ticket % subject is immutable', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "support_tickets_guard_trigger"
  BEFORE UPDATE ON "support_tickets"
  FOR EACH ROW EXECUTE FUNCTION "support_tickets_guard"();
--> statement-breakpoint

-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================

-- In-app notifications. The existing notification_deliveries table records what
-- was SENT over SMS and email; this is what the customer sees in the product,
-- which is a different thing with a different lifecycle (it is read, it is
-- dismissed, it persists).
CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "href" text,
  "read_at" timestamp(6) with time zone,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "notifications_kind_format" CHECK ("kind" ~ '^[A-Z_]{3,40}$')
);
--> statement-breakpoint

CREATE INDEX "notifications_user_idx" ON "notifications" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" ("user_id")
  WHERE "read_at" IS NULL;
--> statement-breakpoint

GRANT USAGE ON TYPE "ticket_status", "ticket_category" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "support_tickets", "notifications" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "support_messages" TO app_role;
