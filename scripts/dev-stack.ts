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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.resolve(ROOT, ".pgdata-dev");

const PORT = 5432;
const OWNER = "bet_owner";
const OWNER_PASSWORD = "bet_owner_dev";
const APP_USER = "bet_app";
const APP_PASSWORD = "bet_app_dev";
const DATABASE = "bet";

function url(user: string, password: string): string {
  return `postgresql://${user}:${password}@127.0.0.1:${PORT}/${DATABASE}`;
}

/**
 * Creates the database in UTF8, whatever the cluster's own encoding is.
 *
 * WHY THIS IS NOT THE DEFAULT AND WHY IT MATTERS. `embedded-postgres` runs
 * `initdb` with the machine's locale, and on a Windows host that is
 * `English_United States.1252` — so `template1`, and every database cloned
 * from it, is WIN1252. Production is UTF8.
 *
 * The consequence is not theoretical. A payout approval whose written reason
 * contained a naira sign — the currency this product is denominated in, printed
 * on every screen — failed with
 *
 *   character with byte sequence 0xe2 0x82 0xa6 in encoding "UTF8"
 *   has no equivalent in encoding "WIN1252"
 *
 * and the administrator saw a 500 on a sensitive action that works perfectly in
 * production. Found by a browser test, because nothing else had ever written a
 * naira sign, an accented customer name or an emoji into a column.
 *
 * A local stack that fails where production succeeds is bad; the same stack
 * SUCCEEDING where production would fail would be worse, and either way the
 * disposable database has to have production's encoding or it is not a rehearsal.
 *
 * `template0` with `LC_COLLATE`/`LC_CTYPE` of `C` is the only combination that
 * can be created regardless of what the cluster was initialised with.
 */
async function createUtf8Database(): Promise<void> {
  const admin = postgres(`postgresql://${OWNER}:${OWNER_PASSWORD}@127.0.0.1:${PORT}/postgres`, {
    max: 1,
    prepare: false,
  });
  try {
    const [existing] = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = ${DATABASE}
    `;
    if (!existing) {
      await admin.unsafe(
        `CREATE DATABASE "${DATABASE}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
      );
      console.log(`created database ${DATABASE} with UTF8 encoding`);
    }

    const [row] = await admin<{ encoding: string }[]>`
      SELECT pg_encoding_to_char(encoding) AS encoding
      FROM pg_database WHERE datname = ${DATABASE}
    `;
    if (row && row.encoding !== "UTF8") {
      throw new Error(
        `the local database is ${row.encoding}, not UTF8. Production is UTF8, so this stack ` +
          `would fail on text production accepts — including the naira sign. Delete .pgdata-dev ` +
          `and start again.`,
      );
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
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
  await createUtf8Database();

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

  const redisUrl = process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379";

  console.log(`
Postgres  ${appUrl}
  owner   ${ownerUrl}
Redis     ${redisUrl}

Put these in .env:
  DATABASE_URL="${appUrl}"
  DIRECT_DATABASE_URL="${appUrl}"
  MIGRATION_DATABASE_URL="${ownerUrl}"
  REDIS_URL="${redisUrl}"

Ready. Ctrl+C to stop.`);

  const shutdown = async () => {
    console.log("\nstopping...");
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
