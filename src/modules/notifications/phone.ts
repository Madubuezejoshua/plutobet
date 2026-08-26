/**
 * Nigerian phone numbers, normalised to E.164.
 *
 * This looks like string tidying and is not. The same person writes their
 * number as `0803 123 4567`, `+2348031234567`, `2348031234567` and
 * `08031234567`, and if those produce four different stored values then:
 *
 *   - one person can hold four accounts, defeating one-account-per-identity;
 *   - per-destination OTP rate limits are bypassed by changing the format,
 *     which costs real money in SMS fees;
 *   - self-exclusion contact matching misses.
 *
 * So normalisation happens once, at the boundary, and only the E.164 form is
 * ever stored or compared.
 */

const NIGERIA = "+234";

/**
 * Mobile network codes in service in Nigeria (MTN, Glo, Airtel, 9mobile).
 *
 * Validated rather than assumed: a 10-digit string that starts with an
 * unassigned prefix is a typo, and discovering that after paying to send an
 * SMS to it is the expensive way to find out.
 */
const MOBILE_PREFIXES = [
  // MTN
  "703", "704", "706", "803", "806", "810", "813", "814", "816", "903", "906", "913", "916",
  // Glo
  "705", "805", "807", "811", "815", "905", "915",
  // Airtel
  "701", "708", "802", "808", "812", "901", "902", "904", "907", "912",
  // 9mobile
  "809", "817", "818", "908", "909",
];

export class InvalidPhoneNumberError extends Error {
  constructor(readonly value: string) {
    super(`not a valid Nigerian mobile number: ${value}`);
    this.name = "InvalidPhoneNumberError";
  }
}

/**
 * Returns the E.164 form (+234XXXXXXXXXX) or throws.
 *
 * Accepts the four shapes above plus spaces, dashes and parentheses.
 */
export function normalizePhone(raw: string): string {
  if (typeof raw !== "string") throw new InvalidPhoneNumberError(String(raw));

  // Strip everything that is not a digit or a leading plus.
  const cleaned = raw.trim().replace(/[\s()\-.]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) throw new InvalidPhoneNumberError(raw);

  let national: string;
  if (cleaned.startsWith("+234")) {
    national = cleaned.slice(4);
  } else if (cleaned.startsWith("234")) {
    national = cleaned.slice(3);
  } else if (cleaned.startsWith("0")) {
    // Domestic trunk prefix: 0803... -> 803...
    national = cleaned.slice(1);
  } else {
    national = cleaned;
  }

  // A Nigerian mobile subscriber number is exactly 10 digits after the
  // country code.
  if (!/^\d{10}$/.test(national)) throw new InvalidPhoneNumberError(raw);
  if (!MOBILE_PREFIXES.includes(national.slice(0, 3))) throw new InvalidPhoneNumberError(raw);

  return `${NIGERIA}${national}`;
}

/** True when the input is a usable Nigerian mobile number. */
export function isValidPhone(raw: string): boolean {
  try {
    normalizePhone(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Display form for support screens and confirmations: +234 803 ***4567.
 *
 * Partially masked because a full number on screen is what a shoulder-surfer
 * or a screenshot in a support ticket leaks.
 */
export function maskPhone(e164: string): string {
  const national = e164.replace(/^\+234/, "");
  if (national.length !== 10) return "+234 ***";
  return `+234 ${national.slice(0, 3)} ***${national.slice(-4)}`;
}

/** Lower-cases and trims an email so it compares consistently. */
export function normalizeEmailDestination(raw: string): string {
  return raw.trim().toLowerCase();
}
