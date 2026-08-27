import { randomBytes } from "node:crypto";

/**
 * Booking codes.
 *
 * Read aloud in a bar, typed from a screenshot, forwarded on WhatsApp. The
 * alphabet is chosen for that, not for density:
 *
 *   0 / O      zero and letter O
 *   1 / I / L  one, letter I, letter L
 *
 * are all excluded, so a mistyped character produces "no such code" rather
 * than somebody else's slip. Losing five characters costs about 0.4 bits each
 * and saves the support call.
 *
 * The prefix makes a code recognisable as ours when it appears out of context
 * — pasted into a chat, read over the phone — which matters because a
 * shareable identifier with no shape is indistinguishable from a typo.
 */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 characters
const BODY_LENGTH = 6; // 31^6 ~= 8.9e8
const PREFIX = "P";

/**
 * Generates a code.
 *
 * Rejection sampling rather than `% ALPHABET.length`: 256 is not a multiple of
 * 31, so modulo would make the first few characters of the alphabet
 * measurably more likely. It matters little for a booking code and the fix is
 * three lines, so there is no reason to accept the bias.
 */
export function generateBookingCode(): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let body = "";

  while (body.length < BODY_LENGTH) {
    for (const byte of randomBytes(BODY_LENGTH * 2)) {
      if (byte >= limit) continue;
      body += ALPHABET[byte % ALPHABET.length];
      if (body.length === BODY_LENGTH) break;
    }
  }

  return `${PREFIX}${body}`;
}

/**
 * Accepts what a person typed.
 *
 * Case, spaces and hyphens are all forgiven, because all three are things
 * people add when reading a code back. The prefix is optional on input for the
 * same reason — someone who types just the body meant the code.
 */
export function normalizeBookingCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith(PREFIX) ? cleaned : `${PREFIX}${cleaned}`;
}

export function isValidBookingCode(code: string): boolean {
  return new RegExp(`^${PREFIX}[${ALPHABET}]{${BODY_LENGTH}}$`).test(code);
}

/** How long a shared code stays loadable. */
export const BOOKING_CODE_TTL_DAYS = 30;

export function bookingCodeExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + BOOKING_CODE_TTL_DAYS * 24 * 60 * 60_000);
}
