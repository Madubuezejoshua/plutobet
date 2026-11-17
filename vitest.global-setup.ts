import { rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(ROOT, "drizzle");
const OWNER = "bet_owner";
const OWNER_PASSWORD = "bet_owner_test_password";
const APP_USER = "bet_app_test";
const APP_PASSWORD = "bet_app_test_password";
const DATABASE = "bet_test";

function connectionUrl(user: string, password: string, port: number): string {
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${DATABASE}`;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not reserve a loopback port for embedded PostgreSQL");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

export default async function globalSetup() {
  // A process-specific cluster prevents two local/CI Vitest invocations from
  // deleting or binding each other's embedded PostgreSQL instance.
  const dataDir = path.resolve(ROOT, `.pgdata-test-${process.pid}`);
  const port = await availableLoopbackPort();

  // This is the only recursively removed path. Resolve and verify it before
  // cleanup so a future refactor cannot turn a stale-test cleanup into a
  // workspace-wide deletion.
  if (
    path.dirname(dataDir) !== ROOT ||
    !/^\.pgdata-test-\d+$/.test(path.basename(dataDir))
  ) {
    throw new Error(`refusing to clean unexpected test database path: ${dataDir}`);
  }
  rmSync(dataDir, { recursive: true, force: true });

  const embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: OWNER,
    password: OWNER_PASSWORD,
    persistent: false,
    postgresFlags: ["-c", "max_connections=200"],
  });

  await embedded.initialise();
  await embedded.start();

  /*
   * UTF8, EXPLICITLY — see the same note in scripts/dev-stack.ts.
   *
   * `initdb` uses the host locale, which on Windows makes template1 WIN1252,
   * and `createDatabase` clones it. Production is UTF8, and a suite that cannot
   * store a naira sign is a suite that cannot test this product's own currency.
   */
  const bootstrap = postgres(
    `postgresql://${OWNER}:${OWNER_PASSWORD}@127.0.0.1:${port}/postgres`,
    { max: 1, prepare: false },
  );
  try {
    await bootstrap.unsafe(
      `CREATE DATABASE "${DATABASE}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
  } finally {
    await bootstrap.end({ timeout: 5 });
  }

  const ownerUrl = connectionUrl(OWNER, OWNER_PASSWORD, port);
  const appUrl = connectionUrl(APP_USER, APP_PASSWORD, port);
  const ownerSql = postgres(ownerUrl, { max: 1, prepare: false });

  try {
    const ownerDb = drizzle(ownerSql);
    await migrate(ownerDb, { migrationsFolder: MIGRATIONS_DIR });

    // `app_role` is created by the real migration. Tests connect as a
    // separate LOGIN member, matching production's owner/runtime split.
    await ownerSql.unsafe(
      `CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app_role`,
    );
  } catch (error) {
    await ownerSql.end({ timeout: 5 });
    await embedded.stop();
    throw error;
  }
  await ownerSql.end({ timeout: 5 });

  process.env.MIGRATION_DATABASE_URL = ownerUrl;
  process.env.DATABASE_URL = appUrl;
  process.env.DIRECT_DATABASE_URL = appUrl;

  if (!process.env.REDIS_URL?.trim()) {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
  }

  return async () => {
    await embedded.stop();
  };
}
