/**
 * Pure multi-sport Live & Hot Games rotation math.
 *
 * Rules:
 * - Each sport category displays up to `SLOTS_PER_CATEGORY` (2) matches at a time.
 * - If a category has <= 2 matches, it stays pinned (no spinning, no switching).
 * - If a category has > 2 matches (e.g. 5 hot games), after `SPINS_BEFORE_ROTATE`
 *   (5) spins it automatically switches to the next window of remaining matches
 *   (e.g. 1–2 -> 3–4 -> 5 -> 1–2), ensuring every hot game in that category gets
 *   visibility.
 */

export const SLOTS_PER_CATEGORY = 2;
export const SPINS_BEFORE_ROTATE = 5;
export const SPIN_INTERVAL_MS = 4500;

export interface CategoryRotationState {
  /** Zero-based window/batch index (0 = items 0..1, 1 = items 2..3, etc.). */
  batchIndex: number;
  /** Completed spins on the current batch (0..SPINS_BEFORE_ROTATE - 1). */
  spinCount: number;
}

export interface CategoryWindow<T> {
  items: T[];
  /** 1-based inclusive start position for display (e.g. 1 in "1–2 of 5"). */
  rangeStart: number;
  /** 1-based inclusive end position for display (e.g. 2 in "1–2 of 5"). */
  rangeEnd: number;
  batchIndex: number;
  totalBatches: number;
  canRotate: boolean;
}

export function canRotateCategory(
  totalMatches: number,
  windowSize: number = SLOTS_PER_CATEGORY,
): boolean {
  return totalMatches > windowSize;
}

export function categoryBatchCount(
  totalMatches: number,
  windowSize: number = SLOTS_PER_CATEGORY,
): number {
  if (totalMatches <= 0) return 0;
  return Math.ceil(totalMatches / Math.max(1, windowSize));
}

export function sliceCategoryWindow<T>(
  items: readonly T[],
  batchIndex: number,
  windowSize: number = SLOTS_PER_CATEGORY,
): CategoryWindow<T> {
  const safeWindow = Math.max(1, windowSize);
  const total = items.length;
  if (total === 0) {
    return {
      items: [],
      rangeStart: 0,
      rangeEnd: 0,
      batchIndex: 0,
      totalBatches: 0,
      canRotate: false,
    };
  }

  const totalBatches = categoryBatchCount(total, safeWindow);
  const normalizedBatch = ((batchIndex % totalBatches) + totalBatches) % totalBatches;
  const start = normalizedBatch * safeWindow;
  const slice = items.slice(start, start + safeWindow);

  return {
    items: slice,
    rangeStart: start + 1,
    rangeEnd: start + slice.length,
    batchIndex: normalizedBatch,
    totalBatches,
    canRotate: canRotateCategory(total, safeWindow),
  };
}

/**
 * Advances a single category's rotation by one spin.
 *
 * Categories with <= `windowSize` matches never spin or switch.
 * Categories with > `windowSize` matches stay on the current window for
 * `spinsBeforeRotate` spins (default 5), then switch to the next batch of
 * remaining matches and reset `spinCount` to 0.
 */
export function advanceCategoryRotation(
  current: CategoryRotationState,
  totalMatches: number,
  spinsBeforeRotate: number = SPINS_BEFORE_ROTATE,
  windowSize: number = SLOTS_PER_CATEGORY,
): CategoryRotationState {
  if (!canRotateCategory(totalMatches, windowSize)) {
    return { batchIndex: 0, spinCount: 0 };
  }

  const totalBatches = categoryBatchCount(totalMatches, windowSize);
  const safeSpins = Math.max(1, spinsBeforeRotate);
  const nextSpin = current.spinCount + 1;

  if (nextSpin >= safeSpins) {
    return {
      batchIndex: (current.batchIndex + 1) % totalBatches,
      spinCount: 0,
    };
  }

  return {
    batchIndex: current.batchIndex % totalBatches,
    spinCount: nextSpin,
  };
}

/**
 * Manually jumps a category forward or backward by `delta` batches, resetting
 * its spin counter so the newly revealed matches get a full 5-spin dwell.
 */
export function stepCategoryBatch(
  current: CategoryRotationState,
  totalMatches: number,
  delta: number,
  windowSize: number = SLOTS_PER_CATEGORY,
): CategoryRotationState {
  if (!canRotateCategory(totalMatches, windowSize)) {
    return { batchIndex: 0, spinCount: 0 };
  }
  const totalBatches = categoryBatchCount(totalMatches, windowSize);
  const nextBatch = (((current.batchIndex + delta) % totalBatches) + totalBatches) % totalBatches;
  return { batchIndex: nextBatch, spinCount: 0 };
}

/**
 * Interleaves the active 2-match window from each sport category into a single
 * hero carousel deck (slot 0 across all sports, then slot 1 across all sports)
 * so every active sport gets prominent hero rotation rather than clustering.
 */
export function buildMultiSportHeroDeck<T>(
  categories: readonly { sport: string; items: readonly T[] }[],
  batchBySport: Readonly<Record<string, number>>,
  windowSize: number = SLOTS_PER_CATEGORY,
): Array<{ sport: string; item: T; batchIndex: number; totalBatches: number; canRotate: boolean }> {
  const activeWindows = categories
    .map((cat) => {
      const win = sliceCategoryWindow(cat.items, batchBySport[cat.sport] ?? 0, windowSize);
      return { sport: cat.sport, win };
    })
    .filter((entry) => entry.win.items.length > 0);

  const deck: Array<{
    sport: string;
    item: T;
    batchIndex: number;
    totalBatches: number;
    canRotate: boolean;
  }> = [];

  for (let slot = 0; slot < windowSize; slot += 1) {
    for (const { sport, win } of activeWindows) {
      const item = win.items[slot];
      if (item !== undefined) {
        deck.push({
          sport,
          item,
          batchIndex: win.batchIndex,
          totalBatches: win.totalBatches,
          canRotate: win.canRotate,
        });
      }
    }
  }

  return deck;
}
