/**
 * Schema validation that needs no database credentials.
 *
 *   node scripts/check-migrations.mjs
 *
 * Runs every migration, in order, against a throwaway embedded PostgreSQL, then
 * asserts the journal and the directory agree. That catches, before anything is
 * deployed:
 *
 *   - a migration file added without a journal entry (it would never run)
 *   - a journal entry whose file was deleted or renamed (the migrator fails)
 *   - SQL that does not apply to a clean database
 *   - two migrations claiming the same index
 *
 * The point of a CLEAN database is that it proves the migrations reconstruct
 * the schema from nothing. Running them against an already-migrated database
 * proves only that they are idempotent, which is a different and weaker claim.
 *
 * Exit codes: 0 valid, 1 invalid, 2 the checker itself failed.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.resolve(ROOT, "drizzle");
const OWNER = "bet_owner";
const OWNER_PASSWORD = "migration_check_password";
const DATABASE = "bet_migration_check";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") throw new Error("could not reserve a port");
  return address.port;
}

async function main() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const entries = journal.entries ?? [];

  console.log(`migrations: ${files.length} file(s), ${entries.length} journal entr(ies)`);

  const journalTags = new Set(entries.map((entry) => entry.tag));
  const fileTags = new Set(files.map((name) => name.replace(/\.sql$/, "")));

  const orphanFiles = [...fileTags].filter((tag) => !journalTags.has(tag));
  const orphanEntries = [...journalTags].filter((tag) => !fileTags.has(tag));

  if (orphanFiles.length > 0) {
    console.error("migrations: file(s) with NO journal entry — these would never run:");
    for (const tag of orphanFiles) console.error(`  ${tag}.sql`);
  }
  if (orphanEntries.length > 0) {
    console.error("migrations: journal entr(ies) with NO file — the migrator will fail:");
    for (const tag of orphanEntries) console.error(`  ${tag}`);
  }
  if (orphanFiles.length > 0 || orphanEntries.length > 0) return 1;

  // Journal order must be strictly increasing, or "apply in order" is undefined.
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].idx <= entries[i - 1].idx) {
      console.error(
        `migrations: journal is out of order at index ${i} (${entries[i - 1].tag} then ${entries[i].tag})`,
      );
      return 1;
    }
  }

  const port = await availablePort();
  const dataDir = path.resolve(ROOT, `.pgdata-migcheck-${process.pid}`);
  if (
    path.dirname(dataDir) !== ROOT ||
    !/^\.pgdata-migcheck-\d+$/.test(path.basename(dataDir))
  ) {
    throw new Error(`refusing to clean unexpected path: ${dataDir}`);
  }
  rmSync(dataDir, { recursive: true, force: true });

  const embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: OWNER,
    password: OWNER_PASSWORD,
    persistent: false,
  });

  let client;
  try {
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase(DATABASE);

    const url = `postgresql://${OWNER}:${OWNER_PASSWORD}@127.0.0.1:${port}/${DATABASE}`;
    client = postgres(url, { max: 1, prepare: false });

    const started = Date.now();
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    const elapsed = Date.now() - started;

    const [applied] = await client`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations
    `;
    const tables = await client`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `;

    console.log(`migrations: applied ${applied.n} of ${files.length} in ${elapsed} ms`);
    console.log(`migrations: ${tables.length} table(s) in public`);

    if (applied.n !== files.length) {
      console.error(
        `migrations: applied ${applied.n} but ${files.length} file(s) exist — the journal and the directory disagree`,
      );
      return 1;
    }

    console.log("migrations: valid — every migration applies to a clean database");
    return 0;
  } finally {
    if (client) await client.end({ timeout: 5 });
    await embedded.stop().catch(() => {});
    await removeDataDir(dataDir);
  }
}

/**
 * Cleanup must never change the verdict.
 *
 * On Windows the stopped PostgreSQL process can still hold its data directory
 * for a moment, so an immediate delete raises EPERM. That is housekeeping, not
 * a schema problem — reporting the migrations as broken because a temporary
 * folder lingered would be a lie, and a confusing one. Retry briefly, then warn
 * and leave it; the name is process-specific, so a stale directory is inert.
 */
async function removeDataDir(dataDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  console.warn(`migrations: could not remove ${path.basename(dataDir)} — delete it manually`);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("migrations: check failed:", error instanceof Error ? error.message : error);
    process.exit(2);
  });
