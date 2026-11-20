import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCA_BOOST_MIN_LEG_ODDS,
  ACCA_BOOST_TIERS,
  accaBoostPreview,
  slipMath,
} from "../slip-math";
import {
  ALL_SPORT_KEYS,
  PRIMARY_SPORT_KEYS,
  SPORTS_CATALOG,
  leaguePriority,
  resolveSportKey,
} from "@/modules/odds/sports-catalog";

test("accaBoostPreview excludes legs below 1.25 qualifying odds", () => {
  const picks = [
    { odds: 1.1 },
    { odds: 1.24 },
    { odds: ACCA_BOOST_MIN_LEG_ODDS },
    { odds: 1.8 },
  ];
  const stake = 10_000n;
  const { returnMinor } = slipMath(picks, stake);
  const boost = accaBoostPreview(picks, stake, returnMinor);

  assert.equal(boost.qualifyingLegs, 2);
  assert.equal(boost.currentPercent, 0);
  assert.equal(boost.nextTierLegs, 3);
  assert.equal(boost.nextTierPercent, 3);
  assert.equal(boost.legsNeededForNext, 1);
  assert.equal(boost.estimatedBonusMinor, 0n);
});

test("accaBoostPreview computes net-profit promo boost at 3, 5, and 10+ qualifying legs", () => {
  const stake = 10_000n;

  const legs3 = [{ odds: 2 }, { odds: 2 }, { odds: 1.5 }];
  const b3 = accaBoostPreview(legs3, stake, slipMath(legs3, stake).returnMinor);
  assert.equal(b3.currentPercent, 3);
  assert.equal(b3.estimatedBonusMinor, 1_500n);
  assert.equal(b3.nextTierLegs, 4);
  assert.equal(b3.nextTierPercent, 5);

  const legs5 = Array.from({ length: 5 }, () => ({ odds: 2 }));
  const b5 = accaBoostPreview(legs5, stake, slipMath(legs5, stake).returnMinor);
  assert.equal(b5.currentPercent, 10);
  assert.equal(b5.estimatedBonusMinor, 31_000n);
  assert.equal(b5.progressPercent, 50);

  const legs12 = Array.from({ length: 12 }, () => ({ odds: 1.3 }));
  const { returnMinor: ret12 } = slipMath(legs12, stake);
  const b12 = accaBoostPreview(legs12, stake, ret12);
  assert.equal(
    b12.currentPercent,
    ACCA_BOOST_TIERS[ACCA_BOOST_TIERS.length - 1]!.percent,
  );
  assert.equal(b12.nextTierLegs, null);
  assert.equal(b12.legsNeededForNext, 0);
  assert.equal(b12.progressPercent, 100);
  assert.equal(b12.estimatedBonusMinor, ((ret12 - stake) * 50n) / 100n);
});

test("SPORTS_CATALOG exposes all 13 unique sports with 5 primary sports first", () => {
  assert.equal(SPORTS_CATALOG.length, 13);
  assert.equal(ALL_SPORT_KEYS.length, 13);
  assert.deepEqual([...PRIMARY_SPORT_KEYS], [
    "football",
    "basketball",
    "tennis",
    "table-tennis",
    "esports",
  ]);
  assert.equal(new Set(ALL_SPORT_KEYS).size, 13);
  assert.equal(resolveSportKey("ice-hockey"), "ice-hockey");
  assert.equal(resolveSportKey("mma"), "mma");
  assert.equal(resolveSportKey("  MIXED-MARTIAL-ARTS "), "mma");
  assert.equal(resolveSportKey("unknown"), "football");
  assert.ok(
    leaguePriority("football", "England - Premier League") <
      leaguePriority("football", "Regional Friendly"),
  );
  assert.ok(
    leaguePriority("basketball", "USA - NBA") <
      leaguePriority("basketball", "Exhibition Match"),
  );
});
