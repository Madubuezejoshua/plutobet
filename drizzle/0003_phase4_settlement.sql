-- Phase 4: settlement — ingested match results.
--
-- Run only through the unpooled owner/migration connection.

CREATE TYPE "match_result_status" AS ENUM ('SETTLED', 'CANCELLED');
--> statement-breakpoint

-- Append-only ingestion history, NOT one row per event.
--
-- Result feeds send duplicates and corrections constantly, and a corrected
-- score is exactly the kind of thing an auditor asks about six months later
-- ("why did this bet settle as a draw when the site now shows 2-1?"). Keeping
-- every ingestion answers that from data. Settlement reads the newest row;
-- idempotency lives on the bet's terminal status, not here, so replaying a
-- feed is harmless.
CREATE TABLE "event_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "status" "match_result_status" NOT NULL,

  -- { "p1": {"home":0,"away":1}, "ft": {"home":1,"away":1}, ... }
  -- Period-keyed rather than flat home/away columns because match-result
  -- markets settle against `ft` while HT/FT needs `p1`, and a single
  -- home/away pair cannot express both.
  "periods" jsonb NOT NULL,

  "provider" text NOT NULL,
  "ingested_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "event_results_periods_is_object" CHECK (jsonb_typeof("periods") = 'object')
);
--> statement-breakpoint
CREATE INDEX "event_results_event_ingested_idx"
  ON "event_results" ("event_id", "ingested_at" DESC);
--> statement-breakpoint

GRANT USAGE ON TYPE "match_result_status" TO app_role;
--> statement-breakpoint

-- Evidence: appended and read, never rewritten. Same treatment as the ledger.
GRANT SELECT, INSERT ON TABLE "event_results" TO app_role;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "event_results" FROM app_role;
