/**
 * Recreates the disposable review database from empty.
 *
 *   npx tsx scripts/reset-review-db.ts
 *
 * The gate sequence in `general.md` §4 begins "on a freshly recreated
 * disposable database", and that step needs a command rather than a paragraph
 * describing one. This is that command.
 *
 * IT DROPS A DATABASE, so it is written to be impossible to point anywhere
 * else. Three independent conditions, all required:
 *
 *   1. The admin connection must be LOOPBACK. A remote host aborts.
 *   2. The database it drops must be named exactly `bet`, the dev stack's
 *      disposable database. Any other name aborts, including one that merely
 *      contains it.
 *   3. `NODE_ENV` must not be `production`.
 *
 * Condition 2 is the one that matters. A loopback check alone would still let
 * this run against a local copy of something somebody cared about, and the
 * whole point of a disposable database is that it is named as one.
 *
 * Migrations and the demo seed are NOT run here. Recreating and repopulating
 * are separate decisions, and a script that did both would be one flag away
 * from being run for the wrong half.
 */
import "dotenv/config";
import postgres from "postgres";

const DISPOSABLE = "bet";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/*
 * The dev stack's owner credentials, from `scripts/dev-stack.ts`. Fixed and
 * checked in on purpose: a local throwaway cluster listening only on loopback
 * has nothing to protect, and a password nobody looks up is one nobody reuses
 * from somewhere that does.
 */
const ADMIN_URL =
  process.env.REVIEW_ADMIN_DATABASE_URL ??
  "postgresql://bet_owner:bet_owner_dev@127.0.0.1:5432/postgres";

function refuse(why: string): never {
  console.error(`${why}\nRefusing to drop anything.`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV is production.");
}

let host: string;
try {
  host = new URL(ADMIN_URL).hostname;
} catch {
  refuse("The admin connection string is not a URL.");
}
// The host is named because that is the point of the message, and a hostname is
// not a credential. Nothing else from the URL is ever printed.
if (!LOOPBACK.has(host)) {
  refuse(`The admin connection points at "${host}", which is not this machine.`);
}

const target = process.argv.find((a) => a.startsWith("--database="))?.slice(11) ?? DISPOSABLE;
if (target !== DISPOSABLE) {
  refuse(
    `Asked to recreate "${target}". This script only ever recreates "${DISPOSABLE}",\n` +
      "the dev stack's disposable database.",
  );
}

async function main(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    // Existing sessions would block the DROP. They belong to a review server or
    // a previous run against a database that is about to cease to exist.
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = '${DISPOSABLE}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${DISPOSABLE}"`);
    /*
     * UTF8 with C collation, matching what the dev stack creates. The embedded
     * cluster initialises under the machine's Windows locale, which produces
     * WIN1252 by default — and a review database in a different encoding from
     * the one migrations were written against is a defect that only surfaces on
     * the first non-ASCII customer name.
     */
    await admin.unsafe(
      `CREATE DATABASE "${DISPOSABLE}" ENCODING 'UTF8' TEMPLATE template0
        LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    const [row] = await admin`
      SELECT pg_encoding_to_char(encoding) AS encoding
        FROM pg_database WHERE datname = ${DISPOSABLE}`;
    console.log(
      `recreated the disposable database "${DISPOSABLE}" (encoding ${row?.encoding ?? "unknown"}).
` +
        "Now run:  npm run db:migrate && npm run db:seed-demo",
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
