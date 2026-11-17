import * as argon2 from "argon2";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

// This value is not assigned to any account. Its hash is created lazily once
// per server instance so unknown-email sign-ins still perform one Argon2
// verification and do not expose account existence through a cheap fast path.
const TIMING_SENTINEL_PASSWORD = "timing-only-sentinel-not-an-account-password";
let timingSentinelHash: Promise<string> | undefined;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

/**
 * Enforces length without composition rules. Long passphrases are accepted,
 * including whitespace and Unicode; arbitrary upper/number/symbol rules make
 * passwords less memorable without materially improving resistance to
 * offline attacks.
 */
export function assertPasswordPolicy(password: string): void {
  const length = Array.from(password).length;

  if (length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(
      `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(
      `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return argon2.hash(password, ARGON2ID_OPTIONS);
}

export async function verifyPassword(passwordHash: string, candidate: string): Promise<boolean> {
  // Verification parameters are encoded in the PHC hash. Passing the
  // current hashing options here is both unnecessary and incompatible with
  // node-argon2's VerifyOptions (which intentionally accepts only a secret).
  return argon2.verify(passwordHash, candidate);
}

export async function consumeUnknownUserPasswordTiming(candidate: string): Promise<void> {
  timingSentinelHash ??= argon2.hash(TIMING_SENTINEL_PASSWORD, ARGON2ID_OPTIONS);
  await argon2.verify(await timingSentinelHash, candidate);
}

export function passwordHashNeedsUpgrade(passwordHash: string): boolean {
  return argon2.needsRehash(passwordHash, ARGON2ID_OPTIONS);
}
