import assert from "node:assert/strict";
import test from "node:test";
import { filterBets, type SerializedBetRow } from "../bets-filter";

const SAMPLE_BETS: SerializedBetRow[] = [
  {
    id: "11111111-aaaa-bbbb-cccc-111111111111",
    status: "WON",
    stake_minor: "100000",
    total_odds_decimal: "2.100",
    potential_return_minor: "210000",
    cashout_value_minor: null,
    cashed_out_stake_minor: "0",
    placed_at: "2026-11-16T12:00:00.000Z",
    settled_at: "2026-11-16T14:00:00.000Z",
    legs: [
      { fixture: "Arsenal v Chelsea", selection: "Arsenal", odds: "2.10", result: "WON" },
    ],
  },
  {
    id: "22222222-aaaa-bbbb-cccc-222222222222",
    status: "LOST",
    stake_minor: "50000",
    total_odds_decimal: "3.400",
    potential_return_minor: "170000",
    cashout_value_minor: null,
    cashed_out_stake_minor: "0",
    placed_at: "2026-11-16T15:00:00.000Z",
    settled_at: "2026-11-16T17:00:00.000Z",
    legs: [
      { fixture: "Liverpool v Man City", selection: "Draw", odds: "3.40", result: "LOST" },
    ],
  },
  {
    id: "33333333-aaaa-bbbb-cccc-333333333333",
    status: "PENDING",
    stake_minor: "200000",
    total_odds_decimal: "4.500",
    potential_return_minor: "900000",
    cashout_value_minor: null,
    cashed_out_stake_minor: "0",
    placed_at: "2026-11-17T08:00:00.000Z",
    settled_at: null,
    legs: [
      { fixture: "Real Madrid v Barcelona", selection: "Over 2.5", odds: "1.80", result: "PENDING" },
      { fixture: "Bayern Munich v Dortmund", selection: "Bayern Munich", odds: "2.50", result: "WON" },
    ],
  },
  {
    id: "44444444-aaaa-bbbb-cccc-444444444444",
    status: "CASHED_OUT",
    stake_minor: "100000",
    total_odds_decimal: "1.900",
    potential_return_minor: "190000",
    cashout_value_minor: "140000",
    cashed_out_stake_minor: "100000",
    placed_at: "2026-11-15T18:00:00.000Z",
    settled_at: "2026-11-15T19:00:00.000Z",
    legs: [
      { fixture: "Enyimba v Kano Pillars", selection: "Enyimba", odds: "1.90", result: "PENDING" },
    ],
  },
];

test("filters bets by team name case-insensitively", () => {
  const result = filterBets(SAMPLE_BETS, "chelsea", "ALL");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, SAMPLE_BETS[0]?.id);
});

test("filters bets by match outcome selection label (e.g. Draw, Over 2.5)", () => {
  const draws = filterBets(SAMPLE_BETS, "draw", "ALL");
  assert.equal(draws.length, 1);
  assert.equal(draws[0]?.id, SAMPLE_BETS[1]?.id);
});

test("filters bets by ticket outcome status text and outcome chip", () => {
  const wonByText = filterBets(SAMPLE_BETS, "won", "ALL");
  assert.equal(wonByText.length, 2); // ticket 1 won + ticket 3 has a WON leg

  const wonByChip = filterBets(SAMPLE_BETS, "", "WON");
  assert.equal(wonByChip.length, 1);
  assert.equal(wonByChip[0]?.id, SAMPLE_BETS[0]?.id);

  const cashedOut = filterBets(SAMPLE_BETS, "cashed out", "ALL");
  assert.equal(cashedOut.length, 1);
  assert.equal(cashedOut[0]?.id, SAMPLE_BETS[3]?.id);
});

test("supports multi-token queries combining team name and outcome", () => {
  const result = filterBets(SAMPLE_BETS, "bayern won", "ALL");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, SAMPLE_BETS[2]?.id);
});

test("combines search query with outcome chip filter", () => {
  const result = filterBets(SAMPLE_BETS, "arsenal", "LOST");
  assert.equal(result.length, 0);
});
