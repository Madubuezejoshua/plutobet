import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authOptions } from "../auth-options";

/**
 * Resolution of the NextAuth signing secret.
 *
 * This is the highest-blast-radius piece of configuration in the app.
 * `authOptions.secret` is a getter that throws, and every page reads a
 * session, so a bad secret does not degrade one feature — it turns the entire
 * site into "A server error occurred", including /api/auth/providers, which
 * answers 500 with an empty body and no clue as to why.
 *
 * A deployment showed exactly that, so these cases are pinned.
 */

const SAVED = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
};

const VALID = "a".repeat(32);

beforeEach(() => {
  delete process.env.AUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;
});

afterEach(() => {
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("auth secret resolution", () => {
  it("accepts a secret of exactly the minimum length", () => {
    process.env.AUTH_SECRET = VALID;
    expect(authOptions.secret).toBe(VALID);
  });

  it("falls back to NEXTAUTH_SECRET when AUTH_SECRET is absent", () => {
    process.env.NEXTAUTH_SECRET = VALID;
    expect(authOptions.secret).toBe(VALID);
  });

  it("treats a BLANK AUTH_SECRET as absent and uses NEXTAUTH_SECRET", () => {
    // The deployment bug. A variable declared in a hosting dashboard but left
    // empty arrives as "", which `??` keeps because it is neither null nor
    // undefined — so the fallback never ran and the app reported the secret as
    // too short while a perfectly good one sat in the other name.
    process.env.AUTH_SECRET = "";
    process.env.NEXTAUTH_SECRET = VALID;
    expect(authOptions.secret).toBe(VALID);
  });

  it("treats a whitespace-only AUTH_SECRET as absent", () => {
    process.env.AUTH_SECRET = "   ";
    process.env.NEXTAUTH_SECRET = VALID;
    expect(authOptions.secret).toBe(VALID);
  });

  it("refuses a secret shorter than 32 characters", () => {
    process.env.AUTH_SECRET = "too-short";
    expect(() => authOptions.secret).toThrow(/at least 32 characters/);
  });

  it("refuses to start with no secret at all, rather than inventing one", () => {
    // A generated default would be worse than a crash: it would differ between
    // instances and across restarts, silently invalidating every live session.
    expect(() => authOptions.secret).toThrow(/AUTH_SECRET is required/);
  });

  it("points a stranded operator at the diagnostics", () => {
    // The message is what somebody reads at 2am in a deploy log.
    expect(() => authOptions.secret).toThrow(/api\/health/);
  });
});
