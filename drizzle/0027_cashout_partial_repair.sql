-- Partial cash-out: make it possible at all, and make its exposure exact.
--
-- Run only through the unpooled owner/migration connection.
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- 1. PARTIAL CASH-OUT COULD NEVER HAVE SUCCEEDED.
--
--    0007 added `bets_cashout_matches_status`, which requires
--    `cashout_value_minor IS NULL` for any bet that is not CASHED_OUT. 0016
--    then added partial cash-out, which by definition leaves the bet PENDING
--    while recording the value paid so far — and did not revisit that
--    constraint. Every call to `cashOutPartial` raised 23514 and rolled back.
--
--    It was never noticed because nothing called it: no route, no UI, and no
--    test in the suite exercised the partial path. The full path has always
--    worked and is covered, which is why the feature looked finished.
--
-- 2. EXPOSURE WOULD HAVE BEEN RELEASED TWICE.
--
--    Placement claims `potential_return - stake` on every market of the slip.
--    A partial cash-out releases a proportional slice; settlement then releases
--    the WHOLE original claim again. The double release is floored at zero by
--    `GREATEST`, so it never goes negative — it silently reports a market as
--    carrying no liability while other customers' bets on it still do, and the
--    ceiling then admits risk it was configured to refuse.
--
--    Fixed by recording what has already been given back, so the last release
--    returns the remainder rather than the whole.
--
-- No money is repriced, no history is edited, and no existing row changes
-- meaning: every bet in the database today has `cashed_out_stake_minor = 0`
-- or is fully cashed out, and both satisfy the new constraints unchanged.

-- ============================================================================
-- 1. LIABILITY ALREADY RELEASED
-- ============================================================================

-- How much of this bet's exposure claim has already been given back.
--
-- Placement claims `potential_return_minor - stake_minor` per market and sets
-- this to 0. Every release — a partial cash-out's slice, a full cash-out, or
-- settlement — adds what it released. The final release returns
-- `claim - released_liability_minor`, so the total is exactly the claim however
-- many instalments it took.
--
-- Read and written under the bet's row lock (`FOR UPDATE OF b`), which both
-- cash-out and settlement already take, so a concurrent partial and settlement
-- cannot each compute the same remainder.
ALTER TABLE "bets" ADD COLUMN "released_liability_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Never negative, and never more than was claimed. The upper bound is what
-- makes a double release a loud error rather than a silent floor at zero.
ALTER TABLE "bets" ADD CONSTRAINT "bets_released_liability_valid" CHECK (
  "released_liability_minor" >= 0
  AND "released_liability_minor" <= ("potential_return_minor" - "stake_minor")
);
--> statement-breakpoint

-- ============================================================================
-- 2. LET A PENDING BET CARRY CASH-OUT VALUE
-- ============================================================================

ALTER TABLE "bets" DROP CONSTRAINT "bets_cashout_matches_status";
--> statement-breakpoint

-- The replacement says three things, each of which the old one either said or
-- should have:
--
--   * money taken back is recorded    value IS NOT NULL exactly when some of
--                                     the stake has been bought back
--   * the closing payment is the      cashout_txn_id IS NOT NULL exactly when
--     one that ends the bet           the bet is CASHED_OUT
--   * a closed bet bought back all    CASHED_OUT implies the whole stake
--     of it
--
-- The third is why `cashOutPartial`'s final instalment and `cashOut` both set
-- `cashed_out_stake_minor = stake_minor`: a bet closed by cash-out has no stake
-- left at risk, whichever route closed it.
ALTER TABLE "bets" ADD CONSTRAINT "bets_cashout_matches_status" CHECK (
  ("cashed_out_stake_minor" > 0) = ("cashout_value_minor" IS NOT NULL)
  AND ("status" = 'CASHED_OUT') = ("cashout_txn_id" IS NOT NULL)
  AND ("status" <> 'CASHED_OUT' OR "cashed_out_stake_minor" = "stake_minor")
);
--> statement-breakpoint

-- A bet that has been cashed out in part is still running, so it must still be
-- PENDING or have reached a settled outcome — never some other state.
ALTER TABLE "bets" ADD CONSTRAINT "bets_partial_cashout_status_valid" CHECK (
  "cashed_out_stake_minor" = 0
  OR "cashed_out_stake_minor" = "stake_minor"
  OR "status" IN ('PENDING', 'WON', 'LOST', 'VOID')
);
--> statement-breakpoint

-- ============================================================================
-- 3. INDEX
-- ============================================================================

-- The recovery sweep and the reconciliation checks both look for bets that are
-- still carrying liability. A partial index keeps that cheap as the table grows.
CREATE INDEX "bets_unreleased_liability_idx"
  ON "bets" ("id")
  WHERE "released_liability_minor" < ("potential_return_minor" - "stake_minor");
