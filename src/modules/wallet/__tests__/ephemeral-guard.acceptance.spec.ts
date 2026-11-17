import { afterEach, describe, expect, it } from "vitest";
import {
  assertEphemeralDatabase,
  isEphemeralDatabaseUrl,
  NonEphemeralDatabaseError,
} from "@/db/ephemeral-guard";

/**
 * The guard that would have prevented 400 invented fixtures landing in the
 * production database.
 *
 * An earlier benchmark imported the shared pooled client, so it wrote its
 * generated catalogue into whatever `DATABASE_URL` pointed at. Those rows are
 * still there and would appear on the customer board as real matches.
 *
 * The rewritten benchmark starts its own throwaway cluster, which fixes the
 * default. This guards the remaining hole: somebody passing `--url=` and
 * pointing it somewhere costly. "Be careful" is not a control.
 *
 * The asymmetry is deliberate: refusing a scratch database that looks
 * production-ish is an annoyance, while accepting a production database that
 * looks disposable is a disaster. Every test below is written from that side.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  for (const key of [
    "MIGRATION_DATABASE_URL",
    "PAYSTACK_SECRET_KEY",
    "INNGEST_SIGNING_KEY",
    "B2_APPLICATION_KEY",
  ]) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

function withoutProductionEnv<T>(run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of [
    "MIGRATION_DATABASE_URL",
    "PAYSTACK_SECRET_KEY",
    "INNGEST_SIGNING_KEY",
    "B2_APPLICATION_KEY",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("refusing a non-disposable target", () => {
  it.each([
    ["Neon", "postgresql://u:p@ep-cool-hat-123.us-east-2.aws.neon.tech/neondb"],
    ["Railway", "postgresql://u:p@containers-us-west-1.railway.app:5432/railway"],
    ["Railway proxy", "postgresql://u:p@roundhouse.rlwy.net:1234/railway"],
    ["Supabase", "postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres"],
    ["RDS", "postgresql://u:p@mydb.abc123.us-east-1.rds.amazonaws.com/prod"],
    ["Render", "postgresql://u:p@dpg-abc.render.com/appdb"],
  ])("refuses %s", (_name, url) => {
    const verdict = isEphemeralDatabaseUrl(url);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/managed-database host/);
  });

  it("refuses any non-loopback host, even an unrecognised one", () => {
    // The allowlist is loopback. An unknown host is refused because it is
    // unknown, not because it is on a list of bad ones — a denylist can only
    // ever be out of date.
    const verdict = isEphemeralDatabaseUrl("postgresql://u:p@db.internal.example/scratch");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/loopback/);
  });

  it("refuses a loopback database whose name does not say it is disposable", () => {
    // A developer's local database can hold real work, and "it was only my
    // laptop" is no comfort to whoever lost it.
    const verdict = isEphemeralDatabaseUrl("postgresql://u:p@127.0.0.1:5432/bet");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/disposable/);
  });

  it("refuses an unparseable target rather than assuming the best", () => {
    expect(isEphemeralDatabaseUrl("not a url at all").ok).toBe(false);
  });
});

describe("accepting a genuinely disposable target", () => {
  it.each([
    "postgresql://u:p@127.0.0.1:5432/bet_bench",
    "postgresql://u:p@localhost:5432/bet_test",
    "postgresql://u:p@127.0.0.1:5432/scratch_db",
    "postgresql://u:p@localhost:5432/tmp_fixtures",
  ])("accepts %s", (url) => {
    expect(isEphemeralDatabaseUrl(url).ok).toBe(true);
  });
});

describe("the shell matters as much as the target", () => {
  it("refuses when production configuration is loaded, even for a scratch target", () => {
    process.env.MIGRATION_DATABASE_URL = "postgresql://owner:secret@ep-x.aws.neon.tech/neondb";

    /*
     * THE CONDITION THAT WOULD HAVE PREVENTED THE INCIDENT. The benchmark was
     * run in a shell with a full production `.env` loaded and silently picked
     * up DATABASE_URL. The target here is disposable; the shell is not.
     */
    expect(() =>
      assertEphemeralDatabase("postgresql://u:p@127.0.0.1:5432/bet_bench"),
    ).toThrow(NonEphemeralDatabaseError);
  });

  it("names the offending variables but never their values", () => {
    process.env.PAYSTACK_SECRET_KEY = "fake-value-that-must-never-be-echoed";
    try {
      assertEphemeralDatabase("postgresql://u:p@127.0.0.1:5432/bet_bench");
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("PAYSTACK_SECRET_KEY");
      // The whole point: a refusal must not become a second leak.
      expect(message).not.toContain("fake-value-that-must-never-be-echoed");
    }
  });

  it("never echoes the target URL in a refusal", () => {
    const url = "postgresql://neondb_owner:fake-db-password-never-echoed@ep-x.aws.neon.tech/neondb";
    try {
      assertEphemeralDatabase(url);
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("fake-db-password-never-echoed");
      expect(message).not.toContain("neondb_owner");
      expect(message).not.toContain("ep-x.aws.neon.tech");
    }
  });

  it("permits a clean shell with a disposable target", () => {
    withoutProductionEnv(() => {
      expect(() =>
        assertEphemeralDatabase("postgresql://u:p@127.0.0.1:5432/bet_bench"),
      ).not.toThrow();
    });
  });

  it("still refuses a production target from a clean shell", () => {
    // The env check is an ADDITIONAL barrier, never a replacement: a clean
    // shell must not make a production host acceptable.
    withoutProductionEnv(() => {
      expect(() =>
        assertEphemeralDatabase("postgresql://u:p@ep-x.aws.neon.tech/neondb"),
      ).toThrow(/managed-database host/);
    });
  });
});
