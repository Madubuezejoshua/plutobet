/**
 * Refuses to let a destructive benchmark touch a real database.
 *
 * WHY THIS EXISTS
 * ---------------
 * An earlier version of `scripts/bench-sync-fixtures.ts` imported the shared
 * pooled client, so it wrote its generated catalogue into whatever
 * `DATABASE_URL` pointed at — which was production Neon. 400 invented fixtures
 * ("Grêmio v Arsenal" and similar) landed alongside real ones and would have
 * appeared on the customer-facing board as real matches.
 *
 * The benchmark was rewritten to start its own throwaway cluster, which fixes
 * the default. It does NOT stop the next person passing `--url=` and pointing
 * it somewhere costly, and "be careful" is not a control.
 *
 * So a benchmark now has to PROVE its target is disposable before it may write.
 * The check is deliberately paranoid in one direction only: it can refuse a
 * scratch database that looks production-ish, which is an annoyance, and it
 * cannot accept a production database that looks disposable, which would be a
 * disaster.
 *
 * NOTHING HERE IS EVER LOGGED. The URL is parsed, judged and discarded; only
 * the host CLASS reaches the caller, never the host or the credentials.
 */

/** Hosts that are unmistakably not disposable. */
const PRODUCTION_HOST_PATTERNS = [
  /\.neon\.tech$/i,
  /\.aws\.neon\.tech$/i,
  /\.render\.com$/i,
  /\.railway\.app$/i,
  /\.rlwy\.net$/i,
  /\.supabase\.co$/i,
  /\.amazonaws\.com$/i,
  /\.azure\.com$/i,
  /\.gcp\./i,
  /\.digitalocean\.com$/i,
  /\.planetscale\./i,
  /\.vercel-storage\.com$/i,
];

/** Loopback only. A disposable database lives on the machine running the test. */
const EPHEMERAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/**
 * Environment variables whose presence means "a real deployment is configured
 * in this shell". Not proof the target is production, but proof the operator is
 * one typo away from it.
 */
const PRODUCTION_ENV_MARKERS = [
  "MIGRATION_DATABASE_URL",
  "PAYSTACK_SECRET_KEY",
  "INNGEST_SIGNING_KEY",
  "B2_APPLICATION_KEY",
];

export class NonEphemeralDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonEphemeralDatabaseError";
  }
}

export interface EphemeralCheck {
  ok: boolean;
  /** Safe to print. Never contains a host, a user or a password. */
  reason: string;
}

/**
 * Judges whether a URL points at a throwaway database.
 *
 * Returns a verdict rather than throwing, so callers can report several
 * problems at once; `assertEphemeralDatabase` is the throwing wrapper.
 */
export function isEphemeralDatabaseUrl(url: string): EphemeralCheck {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "target is not a parseable URL" };
  }

  const host = parsed.hostname.toLowerCase();

  if (PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return {
      ok: false,
      reason: "target is a known managed-database host, which is never disposable",
    };
  }

  if (!EPHEMERAL_HOSTS.has(host)) {
    return {
      ok: false,
      reason: "target is not on loopback; a disposable database runs on this machine",
    };
  }

  /*
   * The database NAME must say what it is.
   *
   * Loopback alone is not enough: a developer's local database can hold real
   * work, and "it was only my laptop" is no comfort to whoever lost it.
   */
  const database = parsed.pathname.replace(/^\//, "").toLowerCase();
  if (!/(bench|test|scratch|tmp|temp|ephemeral)/.test(database)) {
    return {
      ok: false,
      reason:
        "database name does not identify itself as disposable " +
        "(expected one of: bench, test, scratch, tmp, temp, ephemeral)",
    };
  }

  return { ok: true, reason: "loopback host with a disposable database name" };
}

/**
 * Throws unless the target is provably disposable AND the shell is not holding
 * production configuration.
 *
 * The second condition is the one that would have prevented the incident: the
 * benchmark was run in a shell with a full production `.env` loaded, and picked
 * up `DATABASE_URL` without anybody intending it.
 */
export function assertEphemeralDatabase(
  url: string,
  opts: { allowProductionEnv?: boolean } = {},
): void {
  const verdict = isEphemeralDatabaseUrl(url);
  if (!verdict.ok) {
    throw new NonEphemeralDatabaseError(
      `refusing to run a destructive benchmark: ${verdict.reason}. ` +
        `Start a throwaway database, or omit --url to have one started for you.`,
    );
  }

  if (opts.allowProductionEnv) return;

  const markers = PRODUCTION_ENV_MARKERS.filter((name) => process.env[name]?.trim());
  if (markers.length > 0) {
    throw new NonEphemeralDatabaseError(
      `refusing to run: this shell has production configuration loaded ` +
        `(${markers.join(", ")}). The target looks disposable, but one mistyped ` +
        `variable away is a real database. Run this from a shell without a production .env.`,
    );
  }
}
