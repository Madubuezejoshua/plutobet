import test from "node:test";
import assert from "node:assert/strict";
import { FREE_TIER } from "../budget";
import { ALL_SPORT_KEYS } from "../sports-catalog";
import {
  estimatedDailyBackgroundCalls,
  fixtureCooldownSeconds,
  oddsCooldownSeconds,
  watchlistLimitForSport,
} from "../multi-sport-sync";

test("multi-sport steady-state background calls stay strictly inside FREE_TIER daily background cap", () => {
  const dailyBackgroundCap = FREE_TIER.perDay - FREE_TIER.reserve; // 420
  const est = estimatedDailyBackgroundCalls();
  assert.ok(
    est.total <= dailyBackgroundCap,
    `Expected steady-state daily calls (${est.total}) <= ${dailyBackgroundCap}`,
  );
  assert.ok(est.fixtures > 0 && est.odds > 0);
});

test("every sport in ALL_SPORT_KEYS has positive fixture/odds cooldowns and bounded watchlist limit", () => {
  assert.equal(ALL_SPORT_KEYS.length, 13);
  for (const sport of ALL_SPORT_KEYS) {
    const limit = watchlistLimitForSport(sport);
    assert.ok(limit >= 10 && limit <= 20, `${sport} watchlist limit out of bounds: ${limit}`);
    assert.ok(fixtureCooldownSeconds(sport) >= 3600, `${sport} fixture cooldown too aggressive`);
    assert.ok(oddsCooldownSeconds(sport) >= 1800, `${sport} odds cooldown too aggressive`);
  }
  assert.equal(watchlistLimitForSport("football"), 20);
  assert.equal(watchlistLimitForSport("basketball"), 10);
});
