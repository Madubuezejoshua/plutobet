/**
 * Persistent local Postgres + Redis for interactive dev use —
 * `npm run start:dev`, `prisma studio`, manually poking at the DB. Distinct
 * from vitest.global-setup.ts, which spins up ephemeral instances scoped to a
 * single `vitest run`. Postgres here keeps its data across restarts and both
 * match the ports in .env.example, so this is a drop-in stand-in for
 * "docker compose up" wherever Docker isn't available.
 *
 *   npx tsx scripts/dev-db.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { RedisMemoryServer } from "redis-memory-server";

const PORT = 5432;
const REDIS_PORT = 6379;
const DATA_DIR = path.resolve(__dirname, "../.pgdata-dev");
const USER = "bet";
const PASSWORD = "bet_dev_password";
const DB_NAME = "bet";

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: true,
    postgresFlags: ["-c", "max_connections=300"],
  });

  // Unlike the ephemeral test instance, this data dir is meant to survive
  // restarts (persistent: true) — so only run initdb the first time. PG_
  // VERSION is Postgres's own marker of an already-initialized data
  // directory; initdb refuses to run against a non-empty one.
  const alreadyInitialised = existsSync(path.join(DATA_DIR, "PG_VERSION"));
  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(DB_NAME);
  } catch {
    // Already exists from a previous run — persistent: true means this is
    // expected, not an error.
  }

  const databaseUrl = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}?schema=public`;
  console.log(`Postgres is up: ${databaseUrl}`);

  execFileSync(process.execPath, [path.resolve(__dirname, "../node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });

  // Redis on the fixed .env port so the app finds it without extra config.
  // Not persistent — the odds cache and BullMQ queues are both safe to lose
  // on restart (the sync worker repopulates, repeatable jobs re-register).
  const redis = new RedisMemoryServer({ instance: { port: REDIS_PORT } });
  const redisHost = await redis.getHost();
  const redisPort = await redis.getPort();
  console.log(`Redis is up:    redis://${redisHost}:${redisPort}`);

  console.log("Ready. Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\nStopping Redis and Postgres...");
    await redis.stop();
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
