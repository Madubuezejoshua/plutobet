-- Scheduled-job heartbeats.
--
-- NOTE: SQL comments here stay within WIN1252, per 0013. A migration is sent
-- as a literal string and re-encoded to the client encoding, and a stray
-- non-Latin-1 character aborts the whole file with an error pointing at a
-- line thirty rows below the real cause.
--
-- WHY THIS EXISTS
-- The settlement poller had never run once in this project's life. Inngest was
-- not running locally and the deployment had no database, so pollMatchResults
-- was never invoked -- and nothing anywhere could tell you that. A bet placed
-- on a finished match would simply sit PENDING forever, and the only signal
-- was a customer asking where their winnings were.
--
-- A job that silently stops is worse than one that fails loudly, so every
-- scheduled run records what it did. The alert in operationalAlerts() reads
-- this table and fires when a job has not succeeded within its allowed window.

CREATE TABLE "job_heartbeats" (
  -- The job name, e.g. 'results'. One row per job, updated in place: this is
  -- current state, not history. Inngest keeps the run log.
  "job" text PRIMARY KEY,

  "last_success_at" timestamp(6) with time zone,
  "last_failure_at" timestamp(6) with time zone,
  -- Truncated on write. A stack trace in an alert is noise, and an error
  -- message can carry a connection string.
  "last_error" text,

  -- What the last successful run actually did. Zero is meaningful: it means
  -- the job ran and found nothing, which is different from not running.
  "processed_count" integer DEFAULT 0 NOT NULL,
  "settled_count" integer DEFAULT 0 NOT NULL,

  -- Cumulative, so a dashboard can show throughput without keeping history.
  "total_runs" bigint DEFAULT 0 NOT NULL,
  "total_failures" bigint DEFAULT 0 NOT NULL,

  "updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "job_heartbeats_job_format" CHECK ("job" ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT "job_heartbeats_counts_non_negative" CHECK (
    "processed_count" >= 0 AND "settled_count" >= 0
    AND "total_runs" >= 0 AND "total_failures" >= 0
  ),
  CONSTRAINT "job_heartbeats_error_paired" CHECK (
    ("last_failure_at" IS NULL) = ("last_error" IS NULL)
  )
);

-- Finding stale jobs is the only query this table serves.
CREATE INDEX "job_heartbeats_last_success_idx" ON "job_heartbeats" ("last_success_at");

-- The runtime writes heartbeats; it must not be able to drop the table that
-- reports on it.
GRANT SELECT, INSERT, UPDATE ON TABLE "job_heartbeats" TO app_role;
