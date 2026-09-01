-- Fair scheduling for result polling.
--
-- NOTE: comments stay within WIN1252, per 0013.
--
-- THE PROBLEM
-- pollFinishedEvents took the 20 oldest unresolved events per tick, ordered by
-- kickoff. Fixtures the provider never scores -- lower-league and amateur
-- matches, of which a 14-day horizon ingests hundreds -- stay unresolved
-- forever and are re-fetched on every single run. Newer events queue behind
-- them.
--
-- Observed: a real customer bet sat 59th of 60 in that queue. Four full poll
-- cycles, roughly 80 provider calls, never reached it. It is throttling rather
-- than deadlock, because some events do resolve and leave -- but a match with
-- money on it can wait behind matches with none, which is the wrong priority.
--
-- THE FIX HAS TWO PARTS
-- 1. Order by whether the event has a pending bet. Money waiting is the only
--    thing that makes a delay matter to anybody.
-- 2. Give each event its own retry schedule, so one permanently unscored
--    fixture cannot occupy a slot on every cycle.
--
-- An event is NEVER marked resolved just because the provider omitted a score;
-- it is only deferred. A provider that is briefly missing data must not cause
-- a bet to go unsettled permanently.

ALTER TABLE "events"
  -- How many times we have asked the provider for this result without getting
  -- a usable one. Drives the backoff below.
  ADD COLUMN "result_poll_attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "result_last_polled_at" timestamp(6) with time zone,
  -- When this event may be polled again. NULL means "eligible now", which is
  -- the correct default for every event that has never been tried.
  ADD COLUMN "result_next_poll_at" timestamp(6) with time zone;

ALTER TABLE "events"
  ADD CONSTRAINT "events_result_poll_attempts_non_negative"
    CHECK ("result_poll_attempts" >= 0);

-- The polling query filters on eligibility and orders by kickoff, so it reads
-- this index directly rather than scanning every historical fixture.
CREATE INDEX "events_result_poll_due_idx"
  ON "events" ("result_next_poll_at", "starts_at")
  WHERE "status" IN ('PENDING', 'LIVE');

GRANT UPDATE ("result_poll_attempts", "result_last_polled_at", "result_next_poll_at")
  ON TABLE "events" TO app_role;
