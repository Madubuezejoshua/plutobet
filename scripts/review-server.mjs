/**
 * The review server: a production build on a DISPOSABLE LOCAL DATABASE.
 *
 *   node scripts/review-server.mjs            # port 3100
 *   node scripts/review-server.mjs --port=3200
 *
 * This is what the Playwright suite and the screenshot capture run against.
 *
 * WHY THIS SCRIPT EXISTS RATHER THAN A SHELL ONE-LINER. `next start` loads
 * `.env`, and in this repository `.env` holds PRODUCTION credentials. Starting
 * the review server by exporting a local `DATABASE_URL` in front of the command
 * works, but it is one forgotten export away from pointing a browser — and the
 * destructive interaction tests — at the real database, and the failure is
 * silent because the app comes up perfectly either way.
 *
 * So the safety is asserted here instead of remembered:
 *
 *   1. Every connection string is set EXPLICITLY. Shell env beats `.env` in
 *      Next.js, so nothing production-shaped can leak in through the file.
 *   2. The host of every one is CHECKED. A URL that is not loopback aborts the
 *      start. This is the check that makes the rest of it safe rather than
 *      merely careful.
 *   3. `AUTH_SECRET` and `IDENTITY_PEPPER` are REVIEW-ONLY values, generated on
 *      first run into a gitignored file. Previously the review process
 *      inherited the production pair from `.env`, which meant a local browser
 *      session was signed with the production secret and local identity numbers
 *      hashed into the production keyspace. Neither is needed to review a
 *      screen, and both are avoidable.
 *
 * The generated file is gitignored and never printed. If it is lost, delete it
 * and the next start makes another — the only cost is that existing local
 * sessions and local identity hashes stop verifying, which for a disposable
 * database is not a cost.
 *
 * `playwright.config.ts` still does not spawn this itself. The base URL is
 * supplied by whoever runs the suite, so pointing the tests somewhere is always
 * a deliberate act.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS_FILE = path.join(ROOT, ".env.review.local");

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const PORT = arg("port", "3100");

/*
 * The dev stack's credentials, from `scripts/dev-stack.ts`. They are fixed and
 * checked in on purpose: a local throwaway cluster that only listens on
 * loopback has nothing to protect, and a password nobody has to look up is one
 * nobody is tempted to reuse from somewhere that does.
 */
const DB = {
  DATABASE_URL: "postgresql://bet_app:bet_app_dev@127.0.0.1:5432/bet",
  DIRECT_DATABASE_URL: "postgresql://bet_app:bet_app_dev@127.0.0.1:5432/bet",
  MIGRATION_DATABASE_URL: "postgresql://bet_owner:bet_owner_dev@127.0.0.1:5432/bet",
  REDIS_URL: "redis://127.0.0.1:6379",
};

/*
 * Connection names the APPLICATION reads BEFORE the four set above.
 *
 * `db-direct.ts` resolves DATABASE_URL_UNPOOLED, then POSTGRES_URL_NON_POOLING,
 * and only then DIRECT_DATABASE_URL. `pooled.ts` reads POSTGRES_URL before
 * DATABASE_URL, and `redis.ts` reads KV_URL before REDIS_URL. So setting the
 * four names above is NOT sufficient: if `.env` ever gains one of these
 * higher-precedence aliases, the app would use it, the money path would open
 * against production, and the loopback check below would still pass because it
 * only ever examined the names this script sets.
 *
 * They are blanked rather than trusted. `.env` does not currently define any of
 * them, which is luck rather than design, and luck is not a control.
 */
const HIGHER_PRECEDENCE_CONNECTIONS = [
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "KV_URL",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
];

/*
 * EXTERNAL PROVIDER CREDENTIALS, BLANKED.
 *
 * `next start` loads `.env`, and this repository's `.env` holds PRODUCTION
 * provider credentials. Overriding the database was never enough on its own:
 *
 *   - B2_* is the KYC DOCUMENT BUCKET. The interaction suite uploads a KYC
 *     document, so a review run was writing test files into the production
 *     store of customers' identity documents.
 *   - ODDS_API_KEY is a live, metered provider. A review run spent real quota.
 *   - INNGEST_* is the production job queue, which settles bets.
 *   - UPSTASH_* is production Redis.
 *   - The TERMII_ and RESEND_ pairs would send a REAL SMS or email;
 *     `otp.service.ts` switches to a live sender the moment either pair is
 *     present, and the interaction suite registers accounts.
 *
 * Blanked, not deleted: `next start` re-reads `.env` in the child, and dotenv
 * leaves a name alone only when it is already DEFINED. An empty string is
 * defined; a deleted name is not, and would be refilled from the file.
 *
 * Every consumer treats empty as absent — `envCheck` in /api/health trims
 * before testing, and `factory.ts` falls back to the sandbox adapter — so the
 * review server runs with the same honest "unconfigured" behaviour a fresh
 * checkout has.
 */
const PROVIDER_CREDENTIALS = [
  "ODDS_API_KEY",
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_PUBLIC_KEY",
  "TERMII_API_KEY",
  "TERMII_SENDER_ID",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "B2_ENDPOINT",
  "B2_REGION",
  "B2_BUCKET",
  "B2_KEY_ID",
  "B2_APPLICATION_KEY",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "SEED_ADMIN_EMAIL",
  "SEED_ADMIN_PASSWORD",
];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Aborts unless every connection string points at this machine. */
function assertLocal(vars) {
  for (const [name, value] of Object.entries(vars)) {
    let host;
    try {
      host = new URL(value).hostname;
    } catch {
      throw new Error(`${name} is not a URL. Refusing to start.`);
    }
    if (!LOOPBACK.has(host)) {
      // The host is named because it is the whole point of the message, and a
      // hostname is not a credential. The rest of the URL is never printed.
      throw new Error(
        `${name} points at "${host}", which is not this machine.\n` +
          "The review server runs destructive tests and only ever runs against a\n" +
          "disposable local database. Refusing to start.",
      );
    }
  }
}

/** Review-only secrets, generated once. Never printed, never committed. */
function reviewSecrets() {
  if (existsSync(SECRETS_FILE)) {
    const found = {};
    for (const line of readFileSync(SECRETS_FILE, "utf8").split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) found[match[1]] = match[2];
    }
    if (found.AUTH_SECRET && found.IDENTITY_PEPPER) return found;
  }

  const made = {
    AUTH_SECRET: randomBytes(32).toString("base64"),
    IDENTITY_PEPPER: randomBytes(32).toString("hex"),
  };
  writeFileSync(
    SECRETS_FILE,
    [
      "# Generated by scripts/review-server.mjs. Gitignored, local only.",
      "# NOT production values and not interchangeable with them. Delete this",
      "# file to roll it; the only thing that breaks is local sessions.",
      `AUTH_SECRET=${made.AUTH_SECRET}`,
      `IDENTITY_PEPPER=${made.IDENTITY_PEPPER}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  console.info(`generated review-only secrets into ${path.basename(SECRETS_FILE)}`);
  return made;
}

/** Every name in the two lists above, mapped to an empty string. */
function blanked() {
  const out = {};
  for (const name of [...HIGHER_PRECEDENCE_CONNECTIONS, ...PROVIDER_CREDENTIALS]) {
    out[name] = "";
  }
  return out;
}

/**
 * Refuses to start if `.env` holds a credential this script has not neutralised.
 *
 * The two lists above are a denylist, and a denylist is only correct until
 * somebody adds a provider. This is the check that notices.
 *
 * SCOPED TO `.env` DELIBERATELY. The first version scanned the whole inherited
 * environment and refused to start over `CLAUDE_CODE_MESSAGING_TOKEN` — an
 * ambient variable belonging to the operator's terminal that this application
 * never reads. A check that fires on unrelated shell variables would be turned
 * off within a week, and the leak it exists to catch would go with it. `.env` is
 * the actual threat: it is the file `next start` loads, it is the file that
 * holds production credentials, and it is the reason this script exists.
 *
 * Names only. No value from `.env` or from this environment is ever printed.
 */
const CREDENTIAL_SHAPED = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD|_SIGNING_KEY|_EVENT_KEY|_APPLICATION_KEY|_KEY_ID|_DSN|_URL)$/;

/** The review server's own generated or explicitly-set-to-local values. */
const ALLOWED = new Set([
  "AUTH_SECRET",
  "IDENTITY_PEPPER",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "AUTH_URL",
  ...Object.keys(DB),
]);

/** Key names defined in `.env`. Values are read but never retained or printed. */
function envFileNames() {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return [];
  const names = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    // Only names whose value is non-empty can leak anything.
    if (match && match[2].trim().replace(/^["']|["']$/g, "") !== "") names.push(match[1]);
  }
  return names;
}

function assertNoInheritedCredentials(childEnv) {
  const leaked = envFileNames()
    .filter((name) => CREDENTIAL_SHAPED.test(name) && !ALLOWED.has(name))
    .filter((name) => String(childEnv[name] ?? "").trim() !== "");

  if (leaked.length > 0) {
    throw new Error(
      `.env defines these credentials and this script does not neutralise them:\n` +
        leaked.map((name) => `  ${name}`).join("\n") +
        `\n\nThe review server runs destructive tests and must not reach a real\n` +
        `provider. Add each to PROVIDER_CREDENTIALS in this file. Refusing to start.`,
    );
  }
}

assertLocal(DB);

const childEnv = {
  ...process.env,
  ...blanked(),
  ...DB,
  ...reviewSecrets(),
};
assertNoInheritedCredentials(childEnv);

const child = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", PORT],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...childEnv,
      NODE_ENV: "production",
      NEXTAUTH_URL: `http://localhost:${PORT}`,
      AUTH_URL: `http://localhost:${PORT}`,
      // Named so the running app can say what it is. A review server that
      // cannot be told apart from production is its own hazard.
      PLUTOBET_ENVIRONMENT: "review",
    },
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
