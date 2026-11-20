import assert from "node:assert/strict";
import test from "node:test";
import {
  SLOTS_PER_CATEGORY,
  SPINS_BEFORE_ROTATE,
  advanceCategoryRotation,
  buildMultiSportHeroDeck,
  canRotateCategory,
  categoryBatchCount,
  sliceCategoryWindow,
  stepCategoryBatch,
} from "../hot-rotation";

test("categories with 2 or fewer matches never spin or switch", () => {
  assert.equal(canRotateCategory(0), false);
  assert.equal(canRotateCategory(1), false);
  assert.equal(canRotateCategory(2), false);
  assert.equal(canRotateCategory(3), true);

  let state = { batchIndex: 0, spinCount: 0 };
  for (let i = 0; i < 12; i += 1) {
    state = advanceCategoryRotation(state, 2);
    assert.deepEqual(state, { batchIndex: 0, spinCount: 0 });
  }
});

test("category with 5 hot games stays for 5 spins then rotates through remaining matches (1-2 -> 3-4 -> 5 -> 1-2)", () => {
  const games = ["G1", "G2", "G3", "G4", "G5"];
  assert.equal(categoryBatchCount(games.length, SLOTS_PER_CATEGORY), 3);

  let state = { batchIndex: 0, spinCount: 0 };

  // Batch 0: games 1 & 2
  const w0 = sliceCategoryWindow(games, state.batchIndex);
  assert.deepEqual(w0.items, ["G1", "G2"]);
  assert.equal(w0.rangeStart, 1);
  assert.equal(w0.rangeEnd, 2);
  assert.equal(w0.totalBatches, 3);
  assert.equal(w0.canRotate, true);

  // Spins 1..4 stay on batch 0
  for (let spin = 1; spin < SPINS_BEFORE_ROTATE; spin += 1) {
    state = advanceCategoryRotation(state, games.length);
    assert.equal(state.batchIndex, 0);
    assert.equal(state.spinCount, spin);
  }

  // 5th spin switches to batch 1 (games 3 & 4)
  state = advanceCategoryRotation(state, games.length);
  assert.deepEqual(state, { batchIndex: 1, spinCount: 0 });
  const w1 = sliceCategoryWindow(games, state.batchIndex);
  assert.deepEqual(w1.items, ["G3", "G4"]);
  assert.equal(w1.rangeStart, 3);
  assert.equal(w1.rangeEnd, 4);

  // Another 5 spins switches to batch 2 (remaining game 5)
  for (let i = 0; i < SPINS_BEFORE_ROTATE; i += 1) {
    state = advanceCategoryRotation(state, games.length);
  }
  assert.deepEqual(state, { batchIndex: 2, spinCount: 0 });
  const w2 = sliceCategoryWindow(games, state.batchIndex);
  assert.deepEqual(w2.items, ["G5"]);
  assert.equal(w2.rangeStart, 5);
  assert.equal(w2.rangeEnd, 5);

  // Another 5 spins wraps back to batch 0 (games 1 & 2)
  for (let i = 0; i < SPINS_BEFORE_ROTATE; i += 1) {
    state = advanceCategoryRotation(state, games.length);
  }
  assert.deepEqual(state, { batchIndex: 0, spinCount: 0 });
});

test("stepCategoryBatch manually steps forward and backward and resets spinCount", () => {
  const afterNext = stepCategoryBatch({ batchIndex: 0, spinCount: 3 }, 5, 1);
  assert.deepEqual(afterNext, { batchIndex: 1, spinCount: 0 });

  const afterPrevWrap = stepCategoryBatch({ batchIndex: 0, spinCount: 2 }, 5, -1);
  assert.deepEqual(afterPrevWrap, { batchIndex: 2, spinCount: 0 });
});

test("buildMultiSportHeroDeck interleaves top 2 matches across all sport categories and respects rotated batches", () => {
  const categories = [
    { sport: "football", items: ["F1", "F2", "F3", "F4", "F5"] },
    { sport: "basketball", items: ["B1", "B2", "B3"] },
    { sport: "boxing", items: ["X1"] },
  ];

  const initialDeck = buildMultiSportHeroDeck(categories, {});
  assert.deepEqual(
    initialDeck.map((d) => `${d.sport}:${d.item}`),
    [
      "football:F1",
      "basketball:B1",
      "boxing:X1",
      "football:F2",
      "basketball:B2",
    ],
  );

  // After football rotates to batch 1 and basketball rotates to batch 1
  const rotatedDeck = buildMultiSportHeroDeck(categories, {
    football: 1,
    basketball: 1,
  });
  assert.deepEqual(
    rotatedDeck.map((d) => `${d.sport}:${d.item}`),
    [
      "football:F3",
      "basketball:B3",
      "boxing:X1",
      "football:F4",
    ],
  );
});
