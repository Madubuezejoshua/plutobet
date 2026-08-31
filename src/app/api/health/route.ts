import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deployment diagnostics.
 *
 * This exists because of a real incident: the first Railway deployment
 * answered every page with an opaque "A server error occurred", and there was
 * no way to tell from outside whether the database was unreachable, a
 * migration was missing, or one environment variable had never been set. It
 * was the last one — but finding that out took a code read, not a request.
 *
 * WHAT THIS MUST NEVER DO
 * -----------------------
 * Report a configuration VALUE. This endpoint is unauthenticated, because a
 * misconfigured deployment usually cannot authenticate anybody — an auth-gated
 * health check is unreachable exactly when it is needed. So it reports only
 * whether each name is set and structurally usable, never what it holds, and
 * connection errors are reduced to a class rather than echoed back (a Postgres
 * failure message happily includes the host, the user, and sometimes the URL).
 */

type CheckState = "ok" | "missing" | "invalid" | "error";

interface Check {
  name: string;
  state: CheckState;
  /** Safe to show a stranger. Never contains a value or an upstream message. */
  detail: string;
  /** Whether the app is unusable without it. */
  blocking: boolean;
}

function envCheck(
  name: string,
  opts: { blocking: boolean; alternatives?: string[]; minLength?: number; whenMissing: string },
): Check {
  const names = [name, ...(opts.alternatives ?? [])];
  const found = names.find((candidate) => process.env[candidate]?.trim());

  if (!found) {
    return {
      name: names.join(" | "),
      state: "missing",
      detail: opts.whenMissing,
      blocking: opts.blocking,
    };
  }

  const value = process.env[found]!.trim();
  if (opts.minLength && value.length < opts.minLength) {
    return {
      name: found,
      state: "invalid",
      detail: `set, but shorter than the required ${opts.minLength} characters`,
      blocking: opts.blocking,
    };
  }

  return { name: found, state: "ok", detail: "set", blocking: opts.blocking };
}

/** Reduces any thrown value to a class name. Upstream messages leak hosts. */
function errorClass(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return `connection failed (${String((error as { code: unknown }).code)})`;
  }
  return "connection failed";
}

async function databaseCheck(): Promise<Check> {
  if (!process.env.DATABASE_URL?.trim() && !process.env.POSTGRES_URL?.trim()) {
    return {
      name: "database",
      state: "missing",
      detail: "DATABASE_URL or POSTGRES_URL is not set",
      blocking: true,
    };
  }

  const { db } = await import("@/db/pooled");
  const { sql } = await import("drizzle-orm");

  // Connectivity first, and on its own. If this fails the database is genuinely
  // unreachable, which is the answer the operator needs.
  try {
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    return { name: "database", state: "error", detail: errorClass(error), blocking: true };
  }

  /*
   * Then the migration count, which is a SEPARATE question and must not be
   * able to fail the connectivity one.
   *
   * `app_role` is granted USAGE on `public` and nothing on the `drizzle`
   * schema, so depending on which role the deployment connects as, this read
   * may be forbidden on a perfectly healthy database. Reporting that as "down"
   * would send an operator hunting a network fault that does not exist.
   */
  try {
    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    const applied = Number(rows[0]?.n ?? 0);

    return applied > 0
      ? { name: "database", state: "ok", detail: `connected, ${applied} migrations applied`, blocking: true }
      : {
          name: "database",
          state: "invalid",
          detail: "connected, but NO migrations are applied — run npm run db:migrate",
          blocking: true,
        };
  } catch {
    return {
      name: "database",
      state: "ok",
      detail: "connected (migration count not readable by this role)",
      blocking: true,
    };
  }
}

async function redisCheck(): Promise<Check> {
  if (!process.env.REDIS_URL?.trim() && !process.env.KV_URL?.trim()) {
    return {
      name: "redis",
      state: "missing",
      detail: "REDIS_URL or KV_URL is not set — rate limiting and OTP storage need it",
      blocking: true,
    };
  }

  try {
    const { getRedisClient } = await import("@/db/redis");
    await getRedisClient().ping();
    return { name: "redis", state: "ok", detail: "connected", blocking: true };
  } catch (error) {
    return { name: "redis", state: "error", detail: errorClass(error), blocking: true };
  }
}

export async function GET() {
  const checks: Check[] = [
    envCheck("AUTH_SECRET", {
      alternatives: ["NEXTAUTH_SECRET"],
      minLength: 32,
      blocking: true,
      // Named explicitly because this is what broke the first deployment:
      // NextAuth throws on a missing secret, and every page that reads a
      // session — which is every page — answers 500 with no other clue.
      whenMissing: "NOT SET — every page will return 500. Generate 32+ chars and set it",
    }),
    envCheck("IDENTITY_PEPPER", {
      blocking: true,
      whenMissing: "NOT SET — KYC identity hashing and self-exclusion cannot work",
    }),
    envCheck("NEXTAUTH_URL", {
      alternatives: ["AUTH_URL"],
      blocking: false,
      whenMissing: "not set — sign-in callbacks may redirect to the wrong host",
    }),
    envCheck("ODDS_API_KEY", {
      blocking: false,
      whenMissing: "not set — fixtures and prices cannot be synced",
    }),
    envCheck("PAYSTACK_SECRET_KEY", {
      blocking: false,
      whenMissing: "not set — deposits and withdrawals are disabled",
    }),
    ...(await Promise.all([databaseCheck(), redisCheck()])),
  ];

  const blocking = checks.filter((c) => c.blocking && c.state !== "ok");
  const degraded = checks.filter((c) => !c.blocking && c.state !== "ok");

  return NextResponse.json(
    {
      status: blocking.length ? "unhealthy" : degraded.length ? "degraded" : "healthy",
      // The single most useful line when a deployment is answering 500s.
      summary: blocking.length
        ? `${blocking.length} blocking problem(s): ${blocking.map((c) => c.name).join(", ")}`
        : degraded.length
          ? `running, with ${degraded.length} feature(s) unconfigured`
          : "all checks passed",
      checks,
      checkedAt: new Date().toISOString(),
    },
    {
      // 503 so an uptime monitor treats a misconfigured deployment as down.
      status: blocking.length ? 503 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}
