import { randomBytes } from "node:crypto";

/**
 * Referral codes.
 *
 * Shared out loud, typed from a screenshot, and read over the phone — so the
 * alphabet deliberately excludes characters that are indistinguishable in the
 * fonts people actually see them in:
 *
 *   0 / O    zero and letter O
 *   1 / I / L
 *
 * Losing five characters costs about 0.4 bits each and saves a support ticket
 * every time somebody mistypes their friend's code.
 */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 characters
const CODE_LENGTH = 8; // 31^8 ≈ 8.5e11

export function generateReferralCode(): string {
  // Rejection sampling rather than `% ALPHABET.length`: 256 is not a multiple
  // of 31, so modulo would make the first few characters measurably more
  // likely. It matters less for a referral code than for a key, but the fix
  // is three lines.
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let code = "";

  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      code += ALPHABET[byte % ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }

  return code;
}

/** Accepts what a person typed: trims, upper-cases, strips spacing. */
export function normalizeReferralCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

export function isValidReferralCode(input: string): boolean {
  return /^[A-Z0-9]{6,12}$/.test(input);
}
