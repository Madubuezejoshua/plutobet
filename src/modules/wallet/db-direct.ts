import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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

export function createDirectSqlClient(databaseUrl: string) {
  return postgres(databaseUrl, {
    // One unpooled Neon connection per serverless instance.
    max: 1,
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
  const value = process.env.DIRECT_DATABASE_URL;
  if (!value) {
    throw new Error("DIRECT_DATABASE_URL is required for the wallet money path");
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
