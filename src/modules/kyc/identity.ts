import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * One-way, searchable digests for Nigerian identity numbers.
 *
 * WHY NOT A PLAIN HASH
 * A BVN and a NIN are both exactly 11 digits: 10^11 candidates. A commodity
 * GPU computes SHA-256 in the tens of billions per second, so the entire
 * keyspace falls in seconds. `sha256(bvn)` is plaintext with extra steps, and
 * storing it would satisfy "never store raw BVN/NIN" only on paper.
 *
 * WHY NOT ARGON2ID
 * A slow KDF with a per-row random salt defeats that attack, but destroys
 * lookup — and lookup is a hard requirement here twice over: self-exclusion
 * must survive re-registration under a new email (§7), and one verified
 * identity must map to one account (multi-accounting). Neither is possible if
 * the same BVN produces a different digest each time.
 *
 * WHAT THIS DOES
 * HMAC-SHA256 under a server-held pepper. Deterministic, so it is searchable;
 * infeasible to reverse without the pepper, which lives outside the database
 * (env var today, KMS when there is one). A dump of the database alone yields
 * nothing.
 *
 * OPERATIONAL CONSEQUENCE
 * The pepper cannot be rotated casually — every stored digest is derived from
 * it. Rotating means re-collecting identity numbers, which you cannot do,
 * so treat it as permanent key material: back it up, restrict it, and never
 * commit it. If it ever leaks, the 11-digit keyspace is brute-forceable again
 * and every stored identity should be considered exposed.
 */

const BVN_PATTERN = /^\d{11}$/;
const NIN_PATTERN = /^\d{11}$/;

export class InvalidIdentityNumberError extends Error {
  constructor(readonly kind: "BVN" | "NIN") {
    // Deliberately does not echo the value: this message reaches logs.
    super(`${kind} must be exactly 11 digits`);
    this.name = "InvalidIdentityNumberError";
  }
}

export class MissingIdentityPepperError extends Error {
  constructor() {
    super("IDENTITY_PEPPER is required to hash identity numbers");
    this.name = "MissingIdentityPepperError";
  }
}

/**
 * Read at call time rather than module load so a process can start (and serve
 * traffic that never touches KYC) without it, and so tests can inject one.
 */
function pepper(): Buffer {
  const value = process.env.IDENTITY_PEPPER;
  if (!value || value.length < 32) throw new MissingIdentityPepperError();
  return Buffer.from(value, "utf8");
}

function digest(kind: "BVN" | "NIN", value: string): string {
  const normalised = value.trim();
  const pattern = kind === "BVN" ? BVN_PATTERN : NIN_PATTERN;
  if (!pattern.test(normalised)) throw new InvalidIdentityNumberError(kind);

  // The kind is part of the input so the same 11 digits presented as a BVN
  // and as a NIN do not collide into one identity.
  return createHmac("sha256", pepper()).update(`${kind}:${normalised}`).digest("hex");
}

export function hashBvn(bvn: string): string {
  return digest("BVN", bvn);
}

export function hashNin(nin: string): string {
  return digest("NIN", nin);
}

/**
 * Constant-time digest comparison.
 *
 * Digests are not secrets in the way a password is, but comparing them with
 * `===` leaks timing that can be used to confirm a guessed identity against a
 * known account. The cost of avoiding that is nil.
 */
export function identityMatches(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Last 4 digits only, for support screens. Never the full number. */
export function maskIdentity(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 4) return "****";
  return `*******${trimmed.slice(-4)}`;
}
