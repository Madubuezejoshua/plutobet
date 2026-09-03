-- The age gate must mean the same thing in the application and the database.
--
-- Run only through the unpooled owner/migration connection.
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- `enforce_minimum_age` compared against `CURRENT_DATE`, which is today's date
-- IN THE DATABASE SERVER'S TIMEZONE. `assertOldEnough` in the application
-- computes age in UTC. Wherever the database is not running in UTC the two
-- disagree for part of every day, and a person exactly eighteen falls in the
-- gap: the service accepts them, the trigger raises, and the customer gets a
-- 500 instead of either an account or a clear refusal.
--
-- Found by a test written on a machine running PDT (UTC-7). A date of
-- 2008-09-03 is exactly eighteen years before 2026-09-03, which is today in
-- UTC; the database, seven hours behind, still read 2026-09-02 and refused it.
--
-- Production Neon runs UTC, so this has almost certainly never fired for a real
-- customer. It is fixed anyway: an age control whose answer depends on where
-- the database happens to be deployed is not a control anyone can attest to,
-- and "it works because the server is configured a particular way" is exactly
-- the kind of assumption that stops being true during a migration.
--
-- ============================================================================
-- WHY UTC AND NOT SOMETHING ELSE
-- ============================================================================
--
-- Age depends on where the person is, which we do not know. UTC is the only
-- choice that is deterministic, identical in every environment, and independent
-- of a deployment detail. It is also within an hour of Nigeria (UTC+1), the
-- market this product serves.
--
-- This does not loosen the gate. It fixes it in one direction only — the
-- database now agrees with the application instead of being stricter by up to a
-- day depending on deployment — and both refuse anyone under eighteen in UTC.

CREATE OR REPLACE FUNCTION "enforce_minimum_age"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- `(now() AT TIME ZONE 'UTC')::date` rather than CURRENT_DATE: the same
  -- calendar day the application uses, wherever this database runs.
  IF NEW."date_of_birth" IS NOT NULL
     AND NEW."date_of_birth" > ((now() AT TIME ZONE 'UTC')::date - INTERVAL '18 years') THEN
    RAISE EXCEPTION 'account holder must be at least 18 years old'
      USING ERRCODE = '23514',
            CONSTRAINT = 'users_minimum_age';
  END IF;
  RETURN NEW;
END;
$$;
