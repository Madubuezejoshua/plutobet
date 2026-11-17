/**
 * Age verification.
 *
 * The legal minimum age for gambling in Nigeria is 18. This is the one rule in
 * the product where being approximately right is not acceptable, so it is
 * enforced in three places on purpose:
 *
 *   here            — so registration refuses with a clear message
 *   the database    — a trigger, so no bug or manual UPDATE can bypass it
 *   the UI          — a max date on the input, purely as a courtesy
 *
 * The database is the control that actually counts. This module exists so the
 * application does not have to provoke a constraint violation to find out.
 */

export const MINIMUM_AGE_YEARS = 18;

/** Nobody alive is older than this; a date before it is corrupt input. */
const EARLIEST_PLAUSIBLE_BIRTH_YEAR = 1900;

export class UnderageError extends Error {
  constructor(readonly ageYears: number) {
    // Deliberately does not echo the date of birth: this message reaches logs.
    super(`account holders must be at least ${MINIMUM_AGE_YEARS} years old`);
    this.name = "UnderageError";
  }
}

export class InvalidDateOfBirthError extends Error {
  constructor(message = "date of birth is not a valid date") {
    super(message);
    this.name = "InvalidDateOfBirthError";
  }
}

/**
 * Whole years elapsed, by calendar — not by dividing elapsed milliseconds.
 *
 * A leap-year-naive `(now - dob) / 365.25 days` calculation is wrong by a day
 * around birthdays, which on this particular boundary means occasionally
 * admitting someone the day before they turn 18.
 */
export function ageInYears(dateOfBirth: Date, asOf: Date = new Date()): number {
  let age = asOf.getUTCFullYear() - dateOfBirth.getUTCFullYear();

  const monthDelta = asOf.getUTCMonth() - dateOfBirth.getUTCMonth();
  const dayDelta = asOf.getUTCDate() - dateOfBirth.getUTCDate();
  // Birthday has not happened yet this year.
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) age -= 1;

  return age;
}

/**
 * Parses a `YYYY-MM-DD` date of birth and asserts the holder is old enough.
 *
 * Returns the canonical string to store. Throws `UnderageError` for someone
 * too young and `InvalidDateOfBirthError` for anything unparseable — two
 * distinct outcomes because the caller shows very different messages for them,
 * and because an underage attempt is worth recording differently from a typo.
 */
export function assertOldEnough(input: string, asOf: Date = new Date()): string {
  const trimmed = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new InvalidDateOfBirthError("date of birth must be in YYYY-MM-DD form");
  }

  // Parsed as UTC midnight so the result does not shift by a day depending on
  // where the server happens to be running.
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new InvalidDateOfBirthError();

  // Catches 2026-02-30, which `Date` silently rolls forward to 2026-03-02.
  if (parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new InvalidDateOfBirthError("that date does not exist");
  }

  if (parsed.getTime() > asOf.getTime()) {
    throw new InvalidDateOfBirthError("date of birth cannot be in the future");
  }
  if (parsed.getUTCFullYear() < EARLIEST_PLAUSIBLE_BIRTH_YEAR) {
    throw new InvalidDateOfBirthError("date of birth is not plausible");
  }

  const age = ageInYears(parsed, asOf);
  if (age < MINIMUM_AGE_YEARS) throw new UnderageError(age);

  return trimmed;
}

/**
 * The latest date of birth that is old enough today.
 *
 * Used for the `max` attribute on the signup input, so the picker cannot
 * offer a date that registration is going to reject anyway.
 */
export function latestEligibleBirthDate(asOf: Date = new Date()): string {
  const month = asOf.getUTCMonth();
  const cutoff = new Date(
    Date.UTC(asOf.getUTCFullYear() - MINIMUM_AGE_YEARS, month, asOf.getUTCDate()),
  );

  /*
   * 29 February has no counterpart 18 years earlier in a non-leap year, and
   * `Date` resolves the impossible date by rolling FORWARD to 1 March. That
   * is the wrong direction: it would offer a cutoff one day younger than the
   * rule allows, so the signup form would present a date the service then
   * refuses — a form that looks broken, on one day in four years.
   *
   * `setUTCDate(0)` steps back to the last day of the intended month, giving
   * 28 February, which is the genuinely latest eligible birth date.
   *
   * Found by the property test in __tests__/age.acceptance.spec.ts, not by
   * reading the code.
   */
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);

  return cutoff.toISOString().slice(0, 10);
}
