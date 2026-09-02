import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { pooledSettings } from "./pool-config";

type PooledSql = ReturnType<typeof postgres>;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required for the pooled database client");
  }
  return databaseUrl;
}

/**
 * Ordinary-read client for Neon's PgBouncer endpoint.
 *
 * `prepare: false` is required with transaction-mode pooling. Money paths do
 * not import this module; they use the wallet-private unpooled direct client.
 *
 * THE POOL SIZE IS NOT 1 ANY MORE. It was, justified as "a single connection
 * per serverless instance" — right for Vercel-style serverless, wrong for
 * Railway, which runs ONE persistent container for every request. There a
 * single connection means the whole application serialises: one slow query on a
 * cold Neon compute blocks every unrelated request behind it, health check
 * included. See `pool-config.ts` for the sizing and its limits.
 *
 * THE SINGLETON MATTERS MORE NOW. Next.js re-evaluates modules on hot reload,
 * so a per-module client would create a NEW pool on every edit and quietly
 * multiply connections until Neon refused them. Stashing it on `globalThis`
 * survives reloads; with `max: 1` this leaked slowly, and with a real pool it
 * would leak ten times faster.
 */
const POOL_SINGLETON = Symbol.for("plutobet.pooledSql");

type GlobalWithPool = typeof globalThis & { [POOL_SINGLETON]?: PooledSql };

export function getPooledSql(): PooledSql {
  const holder = globalThis as GlobalWithPool;
  if (!holder[POOL_SINGLETON]) {
    const settings = pooledSettings();
    holder[POOL_SINGLETON] = postgres(requireDatabaseUrl(), {
      max: settings.max,
      prepare: false,
      connect_timeout: settings.connectTimeout,
      idle_timeout: settings.idleTimeout,
      max_lifetime: settings.maxLifetime,
    });
  }
  return holder[POOL_SINGLETON];
}

function createPooledDatabase() {
  return drizzle(getPooledSql());
}

export type PooledDatabase = ReturnType<typeof createPooledDatabase>;

let pooledDatabase: PooledDatabase | undefined;

export function getPooledDatabase(): PooledDatabase {
  pooledDatabase ??= createPooledDatabase();
  return pooledDatabase;
}

function boundMember<T extends object>(value: T, property: string | symbol): unknown {
  const member = Reflect.get(value, property, value);
  return typeof member === "function" ? member.bind(value) : member;
}

// Next.js evaluates route modules while collecting build metadata. These
// proxies preserve the existing client API while postponing configuration
// validation and connection creation until a request actually uses them.
const pooledSqlTarget = (() => undefined) as unknown as PooledSql;

export const pooledSql = new Proxy(pooledSqlTarget, {
  apply(_target, thisArg, argumentsList) {
    return Reflect.apply(getPooledSql(), thisArg, argumentsList);
  },
  get(_target, property) {
    return boundMember(getPooledSql(), property);
  },
});

export const db = new Proxy({} as PooledDatabase, {
  get(_target, property) {
    return boundMember(getPooledDatabase(), property);
  },
});
