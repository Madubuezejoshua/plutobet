import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the pooled database client");
}

/**
 * Ordinary-read client for Neon's PgBouncer endpoint.
 *
 * `prepare: false` is required with transaction-mode pooling. Money paths do
 * not import this module; they use the wallet-private unpooled direct client.
 * A single connection per serverless instance avoids multiplying connection
 * pressure during scale-out while PgBouncer handles database-side pooling.
 */
export const pooledSql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
});

export const db = drizzle(pooledSql);

