-- Transactional outbox for settlement hand-off.
--
-- NOTE: SQL comments here stay within WIN1252, per 0013. A migration is sent
-- as a literal string and re-encoded to the client encoding, and a stray
-- non-Latin-1 character aborts the whole file with an error pointing at a
-- line thirty rows below the real cause.
--
-- WHY THIS EXISTS
-- --------------
-- A real winning bet stayed PENDING after its event was automatically marked
-- SETTLED. Two independent faults produced that, and this table addresses the
-- second one.
--
-- FAULT 1 (fixed in code): the cadence claim ran OUTSIDE step.run(), so it
-- re-executed on every Inngest invocation. Inngest invokes a function once per
-- step, memoising completed steps. Invocation 1 claimed the slot and ingested
-- results; invocation 2 replayed, found the claim already held by its own
-- first invocation, and returned "not due" -- so the code AFTER the ingestion
-- step, which dispatches settlement, was unreachable by construction.
--
-- FAULT 2 (this table): even with that fixed, the result was written to
-- PostgreSQL in one transaction and the settlement hand-off sent to Inngest in
-- a separate network call. A crash between them strands the bet FOREVER,
-- because pollFinishedEvents only considers events with no stored result -- so
-- the event is never looked at again. A dual write across two systems with no
-- shared commit is exactly the gap an outbox closes.
--
-- The work item is now written in the SAME transaction as the result. Either
-- both exist or neither does. A separate dispatcher drains the table, and can
-- retry for as long as it takes without the provider being involved at all:
-- the result is already stored locally, so settling it must never depend on
-- API budget.

CREATE TYPE "settlement_outbox_status" AS ENUM (
  'PENDING',     -- recorded, not yet handed to the scheduler
  'DISPATCHED',  -- handed over; the settlement fan-out owns it now
  'COMPLETED',   -- settlement finished and verified
  'FAILED'       -- gave up after repeated attempts; needs a human
);
--> statement-breakpoint

CREATE TABLE "settlement_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Event-level idempotency. Two producers racing on the same event -- the
  -- poller and the recovery sweep, say -- must produce ONE work item, not two,
  -- or the fan-out runs twice. The unique index below is what enforces it;
  -- everything else is advisory.
  "idempotency_key" text NOT NULL,

  "status" "settlement_outbox_status" DEFAULT 'PENDING' NOT NULL,

  -- Why the item exists. 'RESULT_INGESTED' is the normal path; 'RECOVERY' is
  -- the sweep finding an inconsistency nobody else noticed. Keeping them
  -- distinguishable is what lets monitoring answer "is the normal path
  -- working, or is recovery quietly carrying the system?"
  "source" text DEFAULT 'RESULT_INGESTED' NOT NULL,

  "cancelled" boolean DEFAULT false NOT NULL,

  "attempts" integer DEFAULT 0 NOT NULL,
  -- Truncated on write. A stack trace in an alert is noise, and an error
  -- message can carry a connection string.
  "last_error" text,

  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp(6) with time zone,
  "completed_at" timestamp(6) with time zone,
  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  -- A row cannot claim to be finished without saying when.
  CONSTRAINT "settlement_outbox_completed_has_time" CHECK (
    ("status" <> 'COMPLETED') OR ("completed_at" IS NOT NULL)
  ),
  CONSTRAINT "settlement_outbox_dispatched_has_time" CHECK (
    ("status" NOT IN ('DISPATCHED', 'COMPLETED')) OR ("dispatched_at" IS NOT NULL)
  ),
  CONSTRAINT "settlement_outbox_source_known" CHECK (
    "source" IN ('RESULT_INGESTED', 'RECOVERY')
  )
);
--> statement-breakpoint

-- THE constraint that makes replay safe. One work item per idempotency key,
-- whichever producer got there first.
CREATE UNIQUE INDEX "settlement_outbox_idempotency_unique"
  ON "settlement_outbox" ("idempotency_key");
--> statement-breakpoint

-- The dispatcher's query: oldest undispatched first.
CREATE INDEX "settlement_outbox_pending_idx"
  ON "settlement_outbox" ("status", "created_at")
  WHERE "status" IN ('PENDING', 'DISPATCHED');
--> statement-breakpoint

CREATE INDEX "settlement_outbox_event_idx" ON "settlement_outbox" ("event_id");
--> statement-breakpoint

-- ============================================================================
-- HEARTBEAT: report the whole chain, not just the first link
-- ============================================================================
--
-- The existing table recorded processed/settled for one job, and the settled
-- count was hardcoded to zero at the point the ingestion step returned. So a
-- run could report SUCCESS with "settled 0" while the dispatch that followed
-- it never happened -- which is precisely the failure that occurred, sitting
-- in front of a monitor built to be unable to see it.
--
-- A result-ingestion success must never silence a settlement failure.

ALTER TABLE "job_heartbeats" ADD COLUMN "run_id" text;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "started_at" timestamp(6) with time zone;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "completed_at" timestamp(6) with time zone;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "ingested_result_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "final_event_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "dispatch_attempted_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "dispatch_accepted_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "settlement_completed_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "settlement_failed_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "recovery_candidate_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "recovered_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "pending_after_run_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD COLUMN "market_closure_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Which stage failed, so an alert can say more than "something broke".
ALTER TABLE "job_heartbeats" ADD COLUMN "error_stage" text;
--> statement-breakpoint

-- Backfill the two legacy columns' meaning into the new ones so historical
-- rows are not silently reinterpreted. processed_count was "events whose
-- result was ingested"; settled_count was always zero and carries no meaning.
UPDATE "job_heartbeats"
SET "ingested_result_count" = "processed_count"
WHERE "processed_count" > 0;

--> statement-breakpoint
-- The runtime enqueues, claims and completes work items. It must not be able
-- to DELETE one: a failed item is evidence that somebody's money did not move,
-- and the application has no business making that evidence disappear. Removal,
-- if it is ever right, is a deliberate act by an owner.
GRANT SELECT, INSERT, UPDATE ON TABLE "settlement_outbox" TO app_role;
--> statement-breakpoint
GRANT USAGE ON TYPE "settlement_outbox_status" TO app_role;
