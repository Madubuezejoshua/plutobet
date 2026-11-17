for (const name of [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "REDIS_URL",
] as const) {
  if (!process.env[name]) {
    throw new Error(`${name} must be provided by vitest.global-setup.ts`);
  }
}

/*
 * A signing secret for tests.
 *
 * This was never set, which meant every code path requiring it was silently
 * untested: OTP codes are HMAC'd under it, and session and step-up
 * authorisation read it. Routes touching those paths answered 500 in tests
 * while appearing to "pass" any assertion that only checked an absence — a
 * crash creates no grant either.
 *
 * A fixed throwaway value, not a credential: it never leaves the test process
 * and signs nothing that outlives it. Anything already in the environment wins,
 * so a developer can override it.
 */
process.env.AUTH_SECRET ??= "vitest-only-secret-not-a-credential-000000";

if (process.env.AUTH_SECRET.length < 32) {
  throw new Error("AUTH_SECRET must be at least 32 characters, even in tests");
}

