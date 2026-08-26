import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type PooledSql = ReturnType<typeof postgres>;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the pooled database client");
  }
  return databaseUrl;
}

/**
 * Ordinary-read client for Neon's PgBouncer endpoint.
 *
 * `prepare: false` is required with transaction-mode pooling. Money paths do
 * not import this module; they use the wallet-private unpooled direct client.
 * A single connection per serverless instance avoids multiplying connection
 * pressure during scale-out while PgBouncer handles database-side pooling.
 */
let pooledSqlClient: PooledSql | undefined;

export function getPooledSql(): PooledSql {
  pooledSqlClient ??= postgres(requireDatabaseUrl(), {
    max: 1,
    prepare: false,
  });
  return pooledSqlClient;
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
