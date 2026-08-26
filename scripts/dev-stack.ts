/**
 * Local Postgres + Redis for development.
 *
 *   npx tsx scripts/dev-stack.ts     (leave running)
 *   npm run dev                      (in another terminal)
 *
 * Stands in for `docker compose up` where Docker is not available. Data
 * persists across restarts, unlike the ephemeral cluster the test suite
 * spins up.
 *
 * It reproduces the PRODUCTION ROLE SPLIT rather than running everything as a
 * superuser: migrations run as an owner, the app connects as a non-owner
 * member of app_role. That split is what makes the ledger's REVOKEs mean
 * anything, and a dev environment that ignores it hides exactly the class of
 * bug those grants exist to catch.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import { RedisMemoryServer } from "redis-memory-server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.resolve(ROOT, ".pgdata-dev");

const PORT = 5432;
const REDIS_PORT = 6379;
const OWNER = "bet_owner";
const OWNER_PASSWORD = "bet_owner_dev";
const APP_USER = "bet_app";
const APP_PASSWORD = "bet_app_dev";
const DATABASE = "bet";

function url(user: string, password: string): string {
  return `postgresql://${user}:${password}@127.0.0.1:${PORT}/${DATABASE}`;
}

async function main(): Promise<void> {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: OWNER,
    password: OWNER_PASSWORD,
    persistent: true,
    postgresFlags: ["-c", "max_connections=200"],
  });

  // initdb refuses to run against an initialised directory, and PG_VERSION is
  // Postgres's own marker that it already has.
  if (!existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
    console.log("initialising a fresh cluster...");
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(DATABASE);
  } catch {
    // Already there from a previous run.
  }

  const ownerUrl = url(OWNER, OWNER_PASSWORD);
  const appUrl = url(APP_USER, APP_PASSWORD);

  // Migrations must run before the app role is granted membership: app_role
  // itself is created by the Phase 1 migration.
  execFileSync(process.execPath, [path.resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), "scripts/migrate.ts"], {
    cwd: ROOT,
    env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl, DIRECT_DATABASE_URL: ownerUrl },
    stdio: "inherit",
  });

  const owner = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    const [existing] = await owner<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname = ${APP_USER}
    `;
    if (!existing) {
      await owner.unsafe(`CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app_role`);
      console.log(`created runtime role ${APP_USER} (member of app_role)`);
    }
  } finally {
    await owner.end({ timeout: 5 });
  }

  const redis = new RedisMemoryServer({ instance: { port: REDIS_PORT } });
  const redisHost = await redis.getHost();
  const redisPort = await redis.getPort();

  console.log(`
Postgres  ${appUrl}
  owner   ${ownerUrl}
Redis     redis://${redisHost}:${redisPort}

Put these in .env:
  DATABASE_URL="${appUrl}"
  DIRECT_DATABASE_URL="${appUrl}"
  MIGRATION_DATABASE_URL="${ownerUrl}"
  REDIS_URL="redis://${redisHost}:${redisPort}"

Ready. Ctrl+C to stop.`);

  const shutdown = async () => {
    console.log("\nstopping...");
    await redis.stop();
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
