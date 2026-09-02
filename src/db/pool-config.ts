/**
 * Connection-pool sizing, validated once and shared by every runtime client.
 *
 * WHY `max: 1` WAS WRONG
 * ----------------------
 * Both runtime clients used `max: 1`, justified in a comment as "a single
 * connection per serverless instance avoids multiplying connection pressure
 * during scale-out". That reasoning is correct for Vercel-style serverless,
 * where each invocation is its own isolated instance and one connection each is
 * exactly right.
 *
 * **Railway is not that.** It runs ONE persistent container serving every
 * request. With `max: 1` the entire application serialises on a single
 * connection: one slow query against a cold Neon compute blocks every unrelated
 * request behind it, including the health check. That is not a theory — the
 * development server wedged repeatedly and had to be restarted, with the
 * scheduler stopped, which is what ruled out scheduler load as the cause.
 *
 * WHY NOT SIMPLY A BIG NUMBER
 * ---------------------------
 * Neon's compute has a bounded `max_connections`, shared across every client:
 * the app, the migration runner, any admin session, and the scheduler. Sizing
 * the pool to "plenty" moves the failure from "requests queue behind one
 * connection" to "the database refuses new connections", which is worse
 * because it is not queued, it is an error.
 *
 * The defaults below are deliberately modest and are documented per client.
 * They are the starting point for one container, not a tuned number — tuning
 * needs production traffic, and inventing one from a laptop would be guessing
 * with extra steps.
 */

/** Hard ceiling. Above this, somebody has mistyped or misunderstood. */
const MAX_ALLOWED_POOL = 50;

export interface PoolSettings {
  /** Connections this client may open. */
  max: number;
  /** Seconds to wait for a free connection before failing loudly. */
  connectTimeout: number;
  /** Seconds an idle connection is kept before being released. */
  idleTimeout: number;
  /** Seconds any single connection may live. Bounds slow leaks. */
  maxLifetime: number;
}

export class PoolConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolConfigurationError";
  }
}

/**
 * Reads a pool size from the environment, refusing anything unusable.
 *
 * Refuses rather than clamping. A deployment that asked for 500 connections has
 * a misunderstanding worth surfacing at boot; silently running with 50 would
 * hide it until the database started refusing connections at 3am. `0` and
 * negatives are refused for the same reason — they are always a mistake, and
 * `0` in particular would mean "never connect", which no caller wants.
 */
export function poolSizeFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  if (!/^\d+$/.test(raw)) {
    // The NAME, never the value: an env var can hold anything, and echoing it
    // back is how a credential ends up in a boot log.
    throw new PoolConfigurationError(`${name} must be a whole number`);
  }
  const value = Number(raw);
  if (value < 1) {
    throw new PoolConfigurationError(`${name} must be at least 1`);
  }
  if (value > MAX_ALLOWED_POOL) {
    throw new PoolConfigurationError(
      `${name} is larger than ${MAX_ALLOWED_POOL}; Neon's compute has a bounded ` +
        `max_connections shared by every client, and exhausting it fails requests ` +
        `outright rather than queueing them`,
    );
  }
  return value;
}

/**
 * The ordinary read path.
 *
 * Default 10. Read queries are short and the pool exists so that one slow one
 * does not block the other nine. Ten is small enough to leave room for the
 * money path, the migration runner and a human with `psql` on a modest Neon
 * compute, and large enough that a single stalled query is no longer an outage.
 */
export function pooledSettings(): PoolSettings {
  return {
    max: poolSizeFromEnv("DATABASE_POOL_MAX", 10),
    connectTimeout: 15,
    idleTimeout: 30,
    maxLifetime: 30 * 60,
  };
}

/**
 * The money path, on the unpooled endpoint.
 *
 * Deliberately SMALLER than the read pool. These transactions take row locks
 * and run `SELECT … FOR UPDATE`; more concurrency here does not mean more
 * throughput, it means more contention for the same rows and more deadlock
 * candidates. Five allows genuine parallelism across different wallets while
 * keeping the blast radius of a lock-holding transaction small.
 *
 * It must never route through PgBouncer in transaction mode — that is a
 * property of the URL, not of this setting, and is why a separate client
 * exists at all.
 */
export function directSettings(): PoolSettings {
  return {
    max: poolSizeFromEnv("DIRECT_DATABASE_POOL_MAX", 5),
    connectTimeout: 15,
    idleTimeout: 20,
    maxLifetime: 30 * 60,
  };
}

/**
 * A one-line, value-free summary for the readiness check.
 *
 * Sizes are configuration, not secrets, so reporting them is safe and useful.
 * Nothing here touches a URL.
 */
export function describePoolConfiguration(): string {
  try {
    const pooled = pooledSettings();
    const direct = directSettings();
    return `pooled max=${pooled.max}, direct max=${direct.max}, connect timeout ${pooled.connectTimeout}s`;
  } catch (error) {
    return error instanceof PoolConfigurationError ? error.message : "invalid pool configuration";
  }
}
