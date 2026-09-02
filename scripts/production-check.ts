/**
 * Launch readiness, reported without ever printing a value.
 *
 *   npm run production:check                      # DEMO readiness (default)
 *   npm run production:check -- --mode=real-money # REAL-MONEY readiness
 *   npm run production:check -- --remote=https://your-app.up.railway.app
 *
 * TWO MODES, BECAUSE THEY ARE DIFFERENT QUESTIONS
 * -----------------------------------------------
 * `demo` asks: can this serve a test account end to end — real fixtures, real
 * odds, a QA-credited bet, automatic settlement — with no real money involved?
 *
 * `real-money` asks: may this take a stranger's money? That needs payment
 * credentials, notification delivery, identity verification, credential
 * rotation, a proven restore, error reporting and a gaming licence. None of it
 * is implied by the demo passing.
 *
 * The distinction exists because a report once said "NEXTAUTH_URL is the only
 * remaining launch blocker". It was the only blocker THIS CHECKER COULD SEE,
 * which is a very different sentence, and the gap between them is where a
 * platform gets launched before it is legal to operate.
 *
 * WHAT IT IS FOR
 * --------------
 * `/api/health` answers "is this deployment serving?" from inside the running
 * app. This answers the earlier question: "is this environment configured well
 * enough to deploy at all?" — including the pieces health cannot see, such as
 * whether the migration role differs from the runtime role, whether Redis is a
 * TCP URL rather than a REST one, and whether the scheduler has ever succeeded.
 *
 * THE RULE
 * --------
 * No value is ever printed. Not truncated, not masked, not "first four
 * characters" — those leak too, and a launch checklist gets pasted into chat
 * far more often than a log does. Every finding is one of:
 *
 *   PRESENT      set and structurally usable
 *   MISSING      not set
 *   INVALID      set but structurally wrong (wrong scheme, too short, REST URL)
 *   UNVERIFIED   could not be checked from here (no access, not deployed yet)
 *
 * Exit codes: 0 launch-ready, 1 a launch-blocking dependency is missing or
 * invalid, 2 the checker itself failed.
 */
import "dotenv/config";

type State = "PRESENT" | "MISSING" | "INVALID" | "UNVERIFIED";

/** Which question is being asked. See the header. */
type Mode = "demo" | "real-money";

const MODE: Mode = process.argv.includes("--mode=real-money") ? "real-money" : "demo";

interface Finding {
  name: string;
  state: State;
  /** Safe for a stranger. Never contains a value or an upstream message. */
  note: string;
  /** Blocks a DEMO launch: the thing cannot serve a test account without it. */
  blocking: boolean;
  /**
   * Blocks a REAL-MONEY launch only.
   *
   * Kept separate so a demo is not held up by a payment credential, and a
   * real-money launch is never waved through because the demo was green.
   */
  realMoneyBlocking?: boolean;
}

const findings: Finding[] = [];

function record(finding: Finding): Finding {
  findings.push(finding);
  return finding;
}

/** Reduces any thrown value to a class. Driver messages carry hosts and users. */
function errorClass(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return `connection failed (${String((error as { code: unknown }).code)})`;
  }
  return "connection failed";
}

function firstSet(names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

function envFinding(
  label: string,
  names: string[],
  opts: {
    blocking: boolean;
    minLength?: number;
    /** Returns null when valid, or a reason. Never echoes the value. */
    validate?: (value: string) => string | null;
    whenMissing: string;
  },
): void {
  const found = firstSet(names);
  if (!found) {
    record({ name: label, state: "MISSING", note: opts.whenMissing, blocking: opts.blocking });
    return;
  }
  if (opts.minLength && found.value.length < opts.minLength) {
    record({
      name: label,
      state: "INVALID",
      note: `set via ${found.name}, but shorter than the required ${opts.minLength} characters`,
      blocking: opts.blocking,
    });
    return;
  }
  const problem = opts.validate?.(found.value);
  if (problem) {
    record({ name: label, state: "INVALID", note: `set via ${found.name}: ${problem}`, blocking: opts.blocking });
    return;
  }
  record({ name: label, state: "PRESENT", note: `set via ${found.name}`, blocking: opts.blocking });
}

function isPostgresUrl(value: string): string | null {
  if (!/^postgres(?:ql)?:\/\//i.test(value)) return "not a postgres:// URL";
  try {
    const url = new URL(value);
    if (!url.hostname) return "no host";
    if (!url.pathname.replace(/^\//, "")) return "no database name";
    return null;
  } catch {
    return "not a parseable URL";
  }
}

async function checkDatabase(label: string, names: string[], blocking: boolean): Promise<void> {
  const found = firstSet(names);
  if (!found) {
    record({ name: label, state: "MISSING", note: `none of ${names.join(", ")} is set`, blocking });
    return;
  }
  const structural = isPostgresUrl(found.value);
  if (structural) {
    record({ name: label, state: "INVALID", note: `set via ${found.name}: ${structural}`, blocking });
    return;
  }

  const row = await connectOnce(found.value, async (client) => {
    const [result] = await client<{ role: string; encoding: string; owner: string }[]>`
      SELECT
        current_user AS role,
        pg_encoding_to_char(d.encoding) AS encoding,
        COALESCE(
          (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
           WHERE c.relname = 'ledger_entries' AND c.relkind = 'r' LIMIT 1),
          'unknown'
        ) AS owner
      FROM pg_database d WHERE d.datname = current_database()
    `;
    return result;
  });

  if (!row.ok) {
    record({ name: label, state: "INVALID", note: row.note, blocking });
    return;
  }

  /*
   * The ROLE NAME is configuration, not a credential, and whether the app
   * connects as the table owner is the whole point of the check: `app_role`
   * must not own the ledger tables, or application code could alter a table a
   * trigger depends on.
   *
   * Reported rather than failed. The money paths issue `SET LOCAL ROLE
   * app_role` inside every transaction, so the separation still holds where it
   * matters even when the connection itself is the owner — but an operator
   * should know which of those two situations they are in.
   */
  const value = row.value;
  const asOwner = value?.role === value?.owner;
  record({
    name: label,
    state: "PRESENT",
    note:
      `connected as role "${value?.role ?? "?"}", encoding ${value?.encoding ?? "?"}` +
      (asOwner ? " — NOTE: this is the ledger table owner; separation relies on SET LOCAL ROLE" : ""),
    blocking,
  });
}

/**
 * One connection attempt, with one retry.
 *
 * Neon's free tier suspends an idle compute, so the FIRST connection after a
 * quiet period can exceed a short timeout while the database is entirely
 * healthy. Reporting that as INVALID sends an owner hunting a fault that does
 * not exist — which is exactly what the first run of this script did. One
 * retry with a longer timeout distinguishes a cold start from a real outage.
 */
async function connectOnce<T>(
  url: string,
  work: (client: import("postgres").Sql) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; note: string }> {
  const postgres = (await import("postgres")).default;
  let lastError: unknown;
  for (const timeout of [20, 30]) {
    const client = postgres(url, { max: 1, prepare: false, connect_timeout: timeout });
    try {
      return { ok: true, value: await work(client) };
    } catch (error) {
      lastError = error;
    } finally {
      await client.end({ timeout: 5 }).catch(() => {});
    }
  }
  return { ok: false, note: `${errorClass(lastError)} after two attempts` };
}

async function checkMigrations(): Promise<void> {
  const found = firstSet(["MIGRATION_DATABASE_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"]);
  if (!found) {
    record({
      name: "migrations applied",
      state: "UNVERIFIED",
      note: "no owner database URL set, so the applied count cannot be read",
      blocking: false,
    });
    return;
  }
  const { readdirSync } = await import("node:fs");
  const onDisk = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).length;

  const result = await connectOnce(found.value, async (client) => {
    const [row] = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations
    `;
    return Number(row?.n ?? 0);
  });
  if (!result.ok) {
    record({ name: "migrations applied", state: "INVALID", note: result.note, blocking: true });
    return;
  }
  const applied = result.value;
  record({
    name: "migrations applied",
    state: applied === onDisk ? "PRESENT" : "INVALID",
    note:
      applied === onDisk
        ? `${applied} of ${onDisk} applied`
        : `${applied} applied but ${onDisk} exist on disk — run npm run db:migrate`,
    blocking: true,
  });
}

async function checkRedis(): Promise<void> {
  const found = firstSet(["REDIS_URL", "KV_URL"]);
  if (!found) {
    record({
      name: "redis",
      state: "MISSING",
      note: "REDIS_URL is not set — rate limiting, OTP storage and the scheduler lock need it",
      blocking: true,
    });
    return;
  }
  /*
   * A REST URL here is the specific mistake worth naming.
   *
   * Upstash shows the REST endpoint most prominently, `ioredis` does not speak
   * REST, and the failure is a connection error at runtime rather than
   * anything at deploy time.
   */
  if (/^https?:\/\//i.test(found.value)) {
    record({
      name: "redis",
      state: "INVALID",
      note: `set via ${found.name}, but it is an HTTP/REST URL — ioredis needs the TCP endpoint (rediss://…:6379)`,
      blocking: true,
    });
    return;
  }
  if (!/^rediss?:\/\//i.test(found.value)) {
    record({ name: "redis", state: "INVALID", note: `set via ${found.name}, but not a redis:// or rediss:// URL`, blocking: true });
    return;
  }

  const { default: Redis } = await import("ioredis");
  const client = new Redis(found.value, {
    lazyConnect: true,
    connectTimeout: 8000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.ping();
    record({ name: "redis", state: "PRESENT", note: "TCP connection established, PING answered", blocking: true });
  } catch (error) {
    record({ name: "redis", state: "INVALID", note: errorClass(error), blocking: true });
  } finally {
    client.disconnect();
  }
}

async function checkSchedulerHeartbeat(): Promise<void> {
  const found = firstSet(["DIRECT_DATABASE_URL", "DATABASE_URL_UNPOOLED", "DATABASE_URL"]);
  if (!found) {
    record({ name: "scheduler heartbeat", state: "UNVERIFIED", note: "no database URL to read it from", blocking: false });
    return;
  }
  const result = await connectOnce(found.value, async (client) =>
    client<{ job: string; last_success_at: Date | null; last_failure_at: Date | null }[]>`
      SELECT job, last_success_at, last_failure_at FROM job_heartbeats ORDER BY job
    `,
  );
  if (!result.ok) {
    record({ name: "scheduler heartbeat", state: "UNVERIFIED", note: result.note, blocking: false });
    return;
  }
  {
    const rows = result.value;
    if (rows.length === 0) {
      record({
        name: "scheduler heartbeat",
        state: "MISSING",
        note: "no job has EVER recorded a run — nothing is triggering the settlement cron",
        blocking: false,
      });
      return;
    }
    const never = rows.filter((r) => !r.last_success_at);
    const stale = rows.filter(
      (r) => r.last_success_at && Date.now() - new Date(r.last_success_at).getTime() > 30 * 60_000,
    );
    record({
      name: "scheduler heartbeat",
      state: never.length > 0 || stale.length > 0 ? "INVALID" : "PRESENT",
      note:
        never.length > 0
          ? `${never.length} job(s) have never succeeded: ${never.map((r) => r.job).join(", ")}`
          : stale.length > 0
            ? `${stale.length} job(s) have not succeeded in 30 minutes: ${stale.map((r) => r.job).join(", ")}`
            : `${rows.length} job(s) reporting recent success`,
      blocking: false,
    });
  }
}

/**
 * What taking a stranger's money actually requires.
 *
 * None of this is implied by the demo passing, and every line is something a
 * regulator, a payment provider or a customer would ask about first. They are
 * recorded as findings rather than prose so the command can REFUSE, instead of
 * printing advice somebody has to remember to read.
 *
 * Several cannot be settled by inspecting an environment variable at all — a
 * licence, a real deposit proof, a restore drill. Those are reported
 * UNVERIFIED and still block, because "we have not checked" and "it is fine"
 * are not the same claim.
 */
function realMoneyRequirements(): void {
  const needsKey = (
    label: string,
    names: string[],
    whenMissing: string,
  ): void => {
    const found = firstSet(names);
    record({
      name: label,
      state: found ? "PRESENT" : "MISSING",
      note: found ? `set via ${found.name}` : whenMissing,
      blocking: false,
      realMoneyBlocking: !found,
    });
  };

  needsKey("Paystack (deposits)", ["PAYSTACK_SECRET_KEY"], "no payment provider — deposits impossible");
  needsKey("Paystack (payouts)", ["PAYSTACK_SECRET_KEY"], "no payment provider — withdrawals impossible");
  needsKey("Termii (SMS)", ["TERMII_API_KEY"], "no SMS provider — phone verification cannot be delivered");
  needsKey("Resend (email)", ["RESEND_API_KEY"], "no email provider — password reset cannot be delivered");
  needsKey("KYC provider", ["KYC_PROVIDER_KEY", "KYC_API_KEY"], "no identity provider — customers cannot be verified");
  needsKey("Sentry DSN", ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"], "runtime errors are reported nowhere");

  /*
   * Facts no environment variable can establish. Each stays UNVERIFIED and
   * blocking until a human records that it was actually done — which is the
   * honest state, and the reason this command cannot be the sole gate.
   */
  const attested = (label: string, note: string): void => {
    record({ name: label, state: "UNVERIFIED", note, blocking: false, realMoneyBlocking: true });
  };

  attested("real deposit proof", "no recorded end-to-end deposit with real money");
  attested("real withdrawal proof", "no recorded end-to-end payout with real money");
  attested("credential rotation", "the exposed credentials have not been rotated — see OWNER_LAUNCH_CHECKLIST.md");
  attested("restore drill", "no restore has been performed and verified — see docs/restore-runbook.md");
  attested("gaming licence", "no licence or independent certification on record");
  attested("settlement bank account", "no registered business bank account on record for payouts");
}

/**
 * Does a compromised web request inherit the ability to drop the ledger?
 *
 * All three configured URLs were found connecting as `neondb_owner`, which
 * owns the ledger tables. The money paths issue `SET LOCAL ROLE app_role` in
 * every transaction and are safe; the pooled READ client does no role handling
 * at all, and every public route uses it.
 *
 * Blocking, and deliberately so. This was previously reported as a NOTE beside
 * a passing check, which is how a privilege problem survives a review.
 */
async function checkRuntimeRole(): Promise<void> {
  try {
    const { auditRoles, isDangerousRuntimeRole } = await import("./audit-db-roles");
    const [runtime, money] = await auditRoles();

    if (!runtime?.configured) {
      record({ name: "runtime db role", state: "MISSING", note: "no runtime database URL", blocking: true });
      return;
    }
    if (runtime.error) {
      record({ name: "runtime db role", state: "UNVERIFIED", note: runtime.error, blocking: false });
      return;
    }

    const dangerous = isDangerousRuntimeRole(runtime);
    record({
      name: "runtime db role",
      state: dangerous ? "INVALID" : "PRESENT",
      // The ROLE NAME is configuration, not a credential, and naming it is the
      // whole point of the finding.
      note: dangerous
        ? `connects as "${runtime.currentUser}", which owns the ledger tables — a compromised ` +
          `read path could DROP, ALTER or TRUNCATE them. Give DATABASE_URL its own ` +
          `least-privilege role (see OWNER_LAUNCH_CHECKLIST.md)`
        : `connects as "${runtime.currentUser}", which owns nothing and cannot alter the ledger`,
      blocking: dangerous,
    });

    if (money?.configured && !money.error) {
      record({
        name: "money db role",
        state: money.isSuperuser ? "INVALID" : "PRESENT",
        note:
          `connects as "${money.currentUser}"` +
          (money.ownsLedgerTables
            ? " (owns ledger tables; every money transaction still issues SET LOCAL ROLE app_role)"
            : ""),
        blocking: money.isSuperuser,
      });
    }
  } catch (error) {
    record({
      name: "runtime db role",
      state: "UNVERIFIED",
      note: error instanceof Error ? error.message.slice(0, 120) : "audit failed",
      blocking: false,
    });
  }
}

/**
 * Is anybody's money stuck?
 *
 * The single most important production question, and the one nothing could
 * answer while a real winning bet sat PENDING for hours behind a green
 * dashboard. Reads only stored state; needs no provider call.
 */
async function checkSettlementConsistency(): Promise<void> {
  const found = firstSet(["DIRECT_DATABASE_URL", "DATABASE_URL_UNPOOLED", "DATABASE_URL"]);
  if (!found) {
    record({ name: "settlement consistency", state: "UNVERIFIED", note: "no database URL", blocking: false });
    return;
  }
  const result = await connectOnce(found.value, async (client) => {
    const [row] = await client<{ pending: number; unpaid: number; stuck: number }[]>`
      SELECT
        (SELECT count(DISTINCT b.id)::int
           FROM bets b
           JOIN bet_legs bl ON bl.bet_id = b.id
           JOIN selections s ON s.id = bl.selection_id
           JOIN markets m ON m.id = s.market_id
           JOIN event_results r ON r.event_id = m.event_id
          WHERE b.status = 'PENDING') AS pending,
        (SELECT count(*)::int FROM bets b
          WHERE b.status = 'WON'
            AND NOT EXISTS (
              SELECT 1 FROM ledger_transactions t
               WHERE t.type = 'PAYOUT'
                 AND (t.reference = b.id::text OR t.metadata->>'betId' = b.id::text)
            )) AS unpaid,
        (SELECT count(*)::int FROM settlement_outbox WHERE status = 'FAILED') AS stuck
    `;
    return row;
  });

  if (!result.ok) {
    record({ name: "settlement consistency", state: "UNVERIFIED", note: result.note, blocking: false });
    return;
  }
  const pending = Number(result.value?.pending ?? 0);
  const unpaid = Number(result.value?.unpaid ?? 0);
  const stuck = Number(result.value?.stuck ?? 0);
  const clean = pending === 0 && unpaid === 0 && stuck === 0;
  record({
    name: "settlement consistency",
    state: clean ? "PRESENT" : "INVALID",
    note: clean
      ? "no bet is waiting on a result we already have"
      : `${pending} bet(s) pending on a final result, ${unpaid} won bet(s) unpaid, ${stuck} abandoned work item(s)`,
    // Blocking: customer money stuck behind a known result is not a soft
    // warning, and treating it as one is how it went unnoticed for hours.
    blocking: true,
  });
}

async function checkAdminBootstrap(): Promise<void> {
  const found = firstSet(["DIRECT_DATABASE_URL", "DATABASE_URL_UNPOOLED", "DATABASE_URL"]);
  if (!found) {
    record({ name: "admin bootstrap", state: "UNVERIFIED", note: "no database URL to read it from", blocking: false });
    return;
  }
  const result = await connectOnce(found.value, async (client) => {
    const [row] = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM admin_role_grants WHERE role = 'SUPER_ADMIN' AND revoked_at IS NULL
    `;
    return Number(row?.n ?? 0);
  });
  if (!result.ok) {
    record({ name: "admin bootstrap", state: "UNVERIFIED", note: result.note, blocking: false });
    return;
  }
  const admins = result.value;
  record({
    name: "admin bootstrap",
    state: admins > 0 ? "PRESENT" : "MISSING",
    // The COUNT, never an identity. Who the administrators are is not a
    // readiness question and does not belong in a checklist.
    note: admins > 0 ? `${admins} active SUPER_ADMIN grant(s)` : "no active SUPER_ADMIN — run npm run db:seed-admin",
    blocking: false,
  });
}

async function checkRemote(baseUrl: string): Promise<void> {
  for (const [label, path, blocking] of [
    ["deployment /api/health", "/api/health", true],
    ["deployment /api/inngest", "/api/inngest", false],
  ] as const) {
    try {
      const res = await fetch(new URL(path, baseUrl), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      let summary = `HTTP ${res.status}`;
      if (path === "/api/health") {
        const body = (await res.json().catch(() => null)) as { status?: string; summary?: string } | null;
        // The health endpoint is built never to return a value, so echoing its
        // own summary is safe — it is the same text a stranger already sees.
        if (body?.status) summary += ` — ${body.status}: ${body.summary ?? ""}`;
      }
      record({
        name: label,
        state: res.ok ? "PRESENT" : "INVALID",
        note: summary,
        blocking,
      });
    } catch (error) {
      record({ name: label, state: "UNVERIFIED", note: errorClass(error), blocking });
    }
  }
}

async function main(): Promise<number> {
  const remote = process.argv.find((a) => a.startsWith("--remote="))?.slice("--remote=".length);

  console.log(`PLUTOBET READINESS — mode: ${MODE.toUpperCase()}`);
  console.log("No configuration value is printed by this script, by design.");
  console.log("");

  envFinding("AUTH_SECRET", ["AUTH_SECRET", "NEXTAUTH_SECRET"], {
    blocking: true,
    minLength: 32,
    whenMissing: "NOT SET — every page that reads a session returns 500",
  });
  envFinding("IDENTITY_PEPPER", ["IDENTITY_PEPPER"], {
    blocking: true,
    minLength: 32,
    whenMissing: "NOT SET — KYC identity hashing and self-exclusion cannot work",
  });
  envFinding("NEXTAUTH_URL", ["NEXTAUTH_URL", "AUTH_URL"], {
    blocking: true,
    validate: (value) => {
      if (!/^https?:\/\//i.test(value)) return "not an absolute URL";
      if (/localhost|127\.0\.0\.1/i.test(value)) {
        return "points at localhost — sign-in callbacks will fail for real users";
      }
      if (!/^https:/i.test(value)) return "not HTTPS — session cookies will not be marked Secure";
      return null;
    },
    whenMissing: "NOT SET — sign-in callbacks redirect to localhost",
  });
  envFinding("ODDS_API_KEY", ["ODDS_API_KEY"], {
    blocking: false,
    whenMissing: "not set — fixtures and prices cannot be synced",
  });
  envFinding("PAYSTACK_SECRET_KEY", ["PAYSTACK_SECRET_KEY"], {
    blocking: false,
    whenMissing: "not set — deposits and withdrawals stay disabled",
  });
  envFinding("INNGEST_EVENT_KEY", ["INNGEST_EVENT_KEY"], {
    blocking: false,
    whenMissing: "not set — scheduled jobs will not run in production",
  });
  envFinding("INNGEST_SIGNING_KEY", ["INNGEST_SIGNING_KEY"], {
    blocking: false,
    whenMissing: "not set — the Inngest serve endpoint cannot verify callers",
  });
  envFinding("B2 storage", ["B2_APPLICATION_KEY"], {
    blocking: false,
    whenMissing: "not set — KYC document upload is unavailable",
  });
  envFinding("SENTRY_DSN", ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"], {
    blocking: false,
    whenMissing: "not set — runtime errors are not reported anywhere",
  });
  /*
   * Pool sizing. `max: 1` on a persistent Railway container makes the whole
   * application serialise on one connection, so this reports what is actually
   * configured — sizes are configuration, not secrets.
   */
  try {
    const { describePoolConfiguration } = await import("@/db/pool-config");
    record({
      name: "connection pools",
      state: "PRESENT",
      note: describePoolConfiguration(),
      blocking: false,
    });
  } catch (error) {
    record({
      name: "connection pools",
      state: "INVALID",
      note: error instanceof Error ? error.message : "invalid pool configuration",
      blocking: true,
    });
  }

  envFinding("APP_DATABASE_ROLE", ["APP_DATABASE_ROLE"], {
    blocking: false,
    whenMissing: "not set — the runtime role defaults, so ownership separation is unverified",
  });

  await checkDatabase("database (pooled)", ["DATABASE_URL", "POSTGRES_URL"], true);
  await checkDatabase("database (direct/unpooled)", ["DIRECT_DATABASE_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"], true);
  await checkDatabase("database (migration/owner)", ["MIGRATION_DATABASE_URL", "DATABASE_URL_UNPOOLED"], true);
  await checkMigrations();
  await checkRedis();
  if (MODE === "real-money") realMoneyRequirements();
  await checkRuntimeRole();
  await checkSchedulerHeartbeat();
  await checkSettlementConsistency();
  await checkAdminBootstrap();
  if (remote) await checkRemote(remote);
  else {
    record({
      name: "deployment health",
      state: "UNVERIFIED",
      note: "no --remote=<url> given, so the deployed instance was not contacted",
      blocking: false,
    });
  }

  const width = Math.max(...findings.map((f) => f.name.length));
  for (const finding of findings) {
    const mark = finding.state === "PRESENT" ? " " : finding.blocking ? "!" : "·";
    console.log(`${mark} ${finding.name.padEnd(width)}  ${finding.state.padEnd(10)}  ${finding.note}`);
  }

  const demoBlocking = findings.filter((f) => f.blocking && f.state !== "PRESENT");
  const moneyBlocking = findings.filter((f) => f.realMoneyBlocking && f.state !== "PRESENT");

  console.log("");
  if (MODE === "demo") {
    if (demoBlocking.length > 0) {
      console.error(`NOT DEMO READY — ${demoBlocking.length} blocking item(s):`);
      for (const f of demoBlocking) console.error(`  - ${f.name}: ${f.note}`);
      console.error("");
      console.error("See OWNER_LAUNCH_CHECKLIST.md for the order these should be fixed in.");
      return 1;
    }
    console.log("DEMO_READY — test identities, QA ledger credit, real fixtures and odds,");
    console.log("test bet placement, automatic ingestion and settlement. No real money.");
    console.log("");
    console.log("This says NOTHING about taking real money. Run:");
    console.log("  npm run production:check -- --mode=real-money");
    return 0;
  }

  /*
   * Real-money mode fails on EITHER list. A payment credential does not excuse
   * a missing database, and a healthy database does not excuse an unlicensed
   * sportsbook.
   */
  const all = [...demoBlocking, ...moneyBlocking];
  if (all.length > 0) {
    console.error(`NOT REAL_MONEY_READY — ${all.length} blocking item(s):`);
    if (demoBlocking.length > 0) {
      console.error("");
      console.error("  Infrastructure:");
      for (const f of demoBlocking) console.error(`    - ${f.name}: ${f.note}`);
    }
    if (moneyBlocking.length > 0) {
      console.error("");
      console.error("  Payments, identity, security and regulation:");
      for (const f of moneyBlocking) console.error(`    - ${f.name}: ${f.note}`);
    }
    console.error("");
    console.error("QA ledger credit is NOT a deposit and must never be presented as one.");
    console.error("See OWNER_LAUNCH_CHECKLIST.md.");
    return 1;
  }

  console.log("REAL_MONEY_READY — every checked requirement is satisfied.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("production-check failed:", error instanceof Error ? error.message : error);
    process.exit(2);
  });
