import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { directSettings } from "@/db/pool-config";
import { auditLog } from "../audit/schema";
import { users } from "../users/schema";
import { ledgerEntries, ledgerTransactions, wallets } from "./schema";

const directSchema = {
  users,
  auditLog,
  wallets,
  ledgerTransactions,
  ledgerEntries,
};

export function createDirectSqlClient(databaseUrl: string, overrides: { max?: number } = {}) {
  const settings = directSettings();
  return postgres(databaseUrl, {
    /*
     * Bounded concurrency on the UNPOOLED endpoint, deliberately smaller than
     * the read pool.
     *
     * This was `max: 1`, described as "one unpooled connection per serverless
     * instance". Railway is one persistent container, so that made every money
     * operation queue behind every other one — and behind any slow read sharing
     * the process.
     *
     * Smaller than the read pool on purpose: these transactions take row locks
     * and run SELECT ... FOR UPDATE, so extra concurrency buys contention, not
     * throughput. Tests pass `max: 1` explicitly where they need a single
     * connection to create real cross-connection contention.
     */
    max: overrides.max ?? settings.max,
    connect_timeout: settings.connectTimeout,
    idle_timeout: settings.idleTimeout,
    max_lifetime: settings.maxLifetime,
    // Do not rely on session-bound prepared statement state.
    prepare: false,
    // Drizzle maps declared bigint columns, but money locking deliberately
    // uses raw SELECT ... FOR UPDATE. postgres-js otherwise returns raw int8
    // values as strings, so configure the driver itself to preserve bigint.
    types: { bigint: postgres.BigInt },
  });
}

export type DirectSqlClient = ReturnType<typeof createDirectSqlClient>;

function isSqlClient(value: string | DirectSqlClient): value is DirectSqlClient {
  return typeof value !== "string";
}

/**
 * Creates an injectable production-shaped Drizzle database. Tests can pass
 * either a URL (and close `database.$client`) or an existing postgres-js
 * client. Multiple instances exercise real cross-connection row locking.
 */
export function createDirectDatabase(input: string | DirectSqlClient) {
  const client = isSqlClient(input) ? input : createDirectSqlClient(input);

  return drizzle(client, { schema: directSchema });
}

export type DirectDatabase = ReturnType<typeof createDirectDatabase>;

function requireDirectDatabaseUrl(): string {
  const value =
    process.env.DATABASE_URL_UNPOOLED?.trim() ||
    process.env.POSTGRES_URL_NON_POOLING?.trim() ||
    process.env.DIRECT_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "DIRECT_DATABASE_URL, DATABASE_URL_UNPOOLED, or POSTGRES_URL_NON_POOLING is required for the wallet money path",
    );
  }
  return value;
}

/** MONEY PATH ONLY. Never replace this with the pooled `db` client. */
let directDatabase: DirectDatabase | undefined;

export function getDirectDatabase(): DirectDatabase {
  directDatabase ??= createDirectDatabase(requireDirectDatabaseUrl());
  return directDatabase;
}

export function getDirectSql(): DirectSqlClient {
  return getDirectDatabase().$client;
}

function boundMember<T extends object>(value: T, property: string | symbol): unknown {
  const member = Reflect.get(value, property, value);
  return typeof member === "function" ? member.bind(value) : member;
}

export const dbDirect = new Proxy({} as DirectDatabase, {
  get(_target, property) {
    return boundMember(getDirectDatabase(), property);
  },
});

const directSqlTarget = (() => undefined) as unknown as DirectSqlClient;

export const directSql = new Proxy(directSqlTarget, {
  apply(_target, thisArg, argumentsList) {
    return Reflect.apply(getDirectSql(), thisArg, argumentsList);
  },
  get(_target, property) {
    return boundMember(getDirectSql(), property);
  },
});
