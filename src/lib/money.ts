/**
 * Naira formatting.
 *
 * Money is integer kobo everywhere in this codebase — `bigint` in TypeScript,
 * `BIGINT` in PostgreSQL. It becomes a string exactly once, here, at the
 * render boundary. Nothing upstream may convert to `number`: 2^53 kobo is
 * about ₦90 trillion, and a float would round somebody's balance long before
 * that.
 *
 * This module was extracted because five pages had each grown their own
 * near-identical copy, and two of them disagreed about negative amounts.
 */

/**
 * ₦12,345.67 — the everyday form. THE ONLY money formatter pages may use.
 *
 * Accepts a string as well as a bigint because money arrives from
 * `db.execute` as a decimal string (postgres-js will not widen BIGINT to a JS
 * number, correctly). Every page that needed a string previously wrote its own
 * copy of this function rather than converting, and four of those five copies
 * dropped the sign: `-1n / 100n` is `0n` and `-1n % 100n` is `-1n`, so a
 * negative kobo value rendered as `₦0.-1`, and -₦400.00 rendered as `₦-400.00`.
 * The worst of them was the regulator and AML report, which is precisely where
 * a negative adjustment shows up.
 */
export function naira(minor: bigint | string): string {
  const value = typeof minor === "string" ? BigInt(minor) : minor;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const kobo = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₦${whole}.${kobo}`;
}

/**
 * ₦12,345 — kobo dropped.
 *
 * For headline figures where two decimal places are noise. Truncates rather
 * than rounds, so a displayed balance is never larger than the real one.
 */
export function nairaWhole(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}₦${whole}`;
}

/** ₦1.2m / ₦450k — for dense dashboard tiles only, never for a user's balance. */
export function nairaCompact(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const units = abs / 100n;
  const sign = negative ? "-" : "";

  if (units >= 1_000_000n) return `${sign}₦${(Number(units) / 1_000_000).toFixed(1)}m`;
  if (units >= 1_000n) return `${sign}₦${(Number(units) / 1_000).toFixed(0)}k`;
  return `${sign}₦${units.toString()}`;
}

/**
 * Naira typed by a person → kobo.
 *
 * Parsed as a decimal string rather than via `Number`, because
 * `Math.round(0.29 * 100)` is 28 in IEEE-754 and that is somebody's money.
 * Returns null for anything that is not a clean, non-negative amount.
 */
export function parseNairaToKobo(input: string): bigint | null {
  const trimmed = input.trim().replace(/[₦,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;

  // The regex above guarantees a leading digit run, but `noUncheckedIndexedAccess`
  // cannot know that — so read the parts defensively rather than asserting.
  const dot = trimmed.indexOf(".");
  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const fraction = dot === -1 ? "" : trimmed.slice(dot + 1);

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
